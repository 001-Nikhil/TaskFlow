const { installProcessGuards } = require('./processGuards');
const db = require('./db');
const redis = require('./redis');
const crypto = require('crypto');

installProcessGuards();

// Generate a unique Id for this worker process instance 
const WORKER_ID = `worker:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
//Helper to pause execution for  backoff delay to prevent retry storms.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

//Base delay will be in milliseconds, (2sec)
const BASE_DELAY = 2000;

const LOCK_TTL_MS = 30000; //30 seconds lock expiry.

const handlers = {
    send_email : async (payload) => {
        console.log(`[Task] Sending email to ${payload.to}...`);
        await sleep(1000);

        //Intentional failure trigger fo rtesting 
        // if (payload.shouldFail) {
        //     throw new Error('SMTP server connection refused (Simulated transient error');
        // }
        console.log(`[Task] Email sent to ${payload.to}`);
    },
    process_image: async (payload) => {
        console.log(`[Task] Resizing image at ${payload.imageUrl}...`);
        await sleep(1000);
        console.log(`[Task] Image resized.`);
    },
};

async function startWorker() {
    console.log(`Worker [${WORKER_ID}] started and waiting for jobs...`);

    while (true) {
        let jobId = null;
        try{
            const result = await redis.brpop('queue:default', 0);
            jobId = result[1];

            console.log(`\n [${WORKER_ID}] Popped Job Id: ${jobId}`);
            
            // ATOMIC LOCK check: attempt to acquire redis lock
            // SET lock:job:<id> <worker_id> NX PX <ttl>

            const lockKey = `lock:job:${jobId}`;
            const acquiredLock = await redis.set(lockKey, WORKER_ID, 'NX', 'PX', LOCK_TTL_MS);

            if (!acquiredLock) {
                console.warn(`[${WORKER_ID}] Lock for Job Id ${jobId} already held by another. Skipping`);
                continue;
            }

            console.log(`[${WORKER_ID}] Lock acquired for Job Id ${jobId}. Processing...`);


            const pgRes = await db.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
            if (pgRes.rows.length === 0) {
                // console.error(`Job ${jobId} not found in database`);
                await redis.del(lockKey); //Release lock if job not found
                continue;
            }

            const job = pgRes.rows[0];

            await db.query(`UPDATE jobs SET status = 'PROCESSING', updated_at = NOW(), processed_at = NOW() WHERE id = $1`, [jobId]);

            console.log(`Status updated to PROCESSING for job: ${jobId}`);

            const handler = handlers[job.type];
            if (!handler) {
                throw new Error(`No handler registered for job type: ${job.type}`);
            }
            await handler(job.payload);

            await db.query(`UPDATE jobs SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`, [jobId]);
            console.log(`Status updated to COMPLETED for job: ${jobId}`);

            //Release the redis lock 
            await redis.del(lockKey);
        }
        catch (err) {
            if(!jobId)  continue; // If jobId is null, skip to next iteration
            const lockKey = `lock:job:${jobId}`;
            console.error('Worker encountered an error:', err.message);

            try {
                // Fetch current retry state from DB
                const jobRes = await db.query('SELECT retry_count, max_retries FROM jobs WHERE id = $1', [jobId]);

                
                if (jobRes.rows.length === 0) {
                    await redis.del(lockKey);
                    continue;
                }
                const {retry_count, max_retries} = jobRes.rows[0];

                if (retry_count < max_retries) {
                    const nextRetryCount = retry_count + 1;

                    //Exponential backoff calculation:
                    const backoffDelay = BASE_DELAY * Math.pow(2, retry_count);

                    console.log(`Scheduling Retry ${nextRetryCount}/${max_retries} in ${backoffDelay / 1000}s...`);

                    //Update retry count and error msg.
                    await db.query(`UPDATE jobs SET retry_count = $1, error_message = $2, status = 'QUEUED', updated_at = NOW() WHERE id = $3`, [nextRetryCount, err.message, jobId]);

                    //Wait out the backoff period before re-enqueueuing to Redis.
                    await redis.del(lockKey);
                    await sleep(backoffDelay);
                    await redis.lpush('queue:default', jobId);
                    // console.log(`Re-queued Job ID ${jobId} to Redis after backoff.`);
            }           
            else {
                console.error(`Job Id ${jobId} exceeded max retries (${max_retries}).`)
                await db.query(`UPDATE jobs SET status = 'FAILED', error_message = $1, updated_at= NOW() WHERE id = $2`, [err.message, jobId]);
                await redis.del(lockKey);
            }
        }
        catch(dbErr) {
            console.error('Failed to handle job failure state:', dbErr);
            await redis.del(lockKey);
        }
        } 
    }
}
startWorker();