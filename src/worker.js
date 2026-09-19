const os = require('os');
const crypto = require('crypto');
const { installProcessGuards } = require('./processGuards');
const pool = require('./db');
const { claimNextJob, extendLease, completeJob, failJob, releaseJob, reapExpiredLeases } = require('./jobs/repository');
const { registerWorker, heartbeatWorker, deregisterWorker, markDeadWorkers } = require('./jobs/workerRegistry');
const { once } = require('./jobs/effects');
const { NonRetryableError } = require('./jobs/errors');
const { handlers } = require('./jobs/handlers');

installProcessGuards();

const WORKER_ID = `worker:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '4', 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '500', 10);
const LEASE_MS = parseInt(process.env.LEASE_MS || '30000', 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || String(Math.floor(LEASE_MS / 3)), 10);
const REAP_INTERVAL_MS = parseInt(process.env.REAP_INTERVAL_MS || '5000', 10);
const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS || '25000', 10);
const DEAD_WORKER_THRESHOLD_MS = parseInt(
    process.env.DEAD_WORKER_THRESHOLD_MS || String(HEARTBEAT_INTERVAL_MS * 3),
    10
);

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (!signal) return;
        if (signal.aborted) {
            clearTimeout(timer);
            reject(new Error('aborted'));
            return;
        }
        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                reject(new Error('aborted'));
            },
            { once: true }
        );
    });
}

let shuttingDown = false;
const inFlight = new Set();
// Job ids currently being processed by this worker process, purely for the
// registry's current_job_id column (a liveness/dashboard hint - the reaper
// depends only on each job's own lease_expires_at, never on this).
const activeJobIds = new Set();
// jobId -> { job, controller } for jobs running right now, so shutdown can
// release + abort whatever is still running when the grace period ends.
const running = new Map();

async function processJob(job) {
    activeJobIds.add(job.id);
    const controller = new AbortController();
    running.set(job.id, { job, controller });
    const timeoutMs = job.timeout_ms;
    const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);
    // Extends the job's DB lease well inside the lease window so a
    // slow-but-alive handler never loses its lease to the reaper mid-run.
    const leaseTimer = setInterval(() => {
        extendLease(pool, { jobId: job.id, workerId: WORKER_ID, attempt: job.attempt, leaseMs: LEASE_MS }).catch(
            (err) => console.error(`[${WORKER_ID}] lease extension failed for job ${job.id}:`, err)
        );
    }, HEARTBEAT_INTERVAL_MS);

    try {
        const handler = handlers[job.type];
        if (!handler) {
            throw new NonRetryableError(`No handler registered for job type: ${job.type}`);
        }

        const ctx = {
            jobId: job.id,
            attempt: job.attempt,
            signal: controller.signal,
            sleep: (ms) => sleep(ms, controller.signal),
            once: (key, fn) => once(pool, job.id, key, fn),
        };

        // Node cannot forcibly kill a running async function; this races the
        // handler against the abort signal so a hung handler doesn't block
        // this lane forever. If the handler ignores the signal, its promise
        // keeps running in the background - the lease reaper is the actual
        // safety net for a handler that never honors cancellation.
        await Promise.race([
            handler(job.payload, ctx),
            new Promise((_, reject) => {
                controller.signal.addEventListener(
                    'abort',
                    () => {
                        reject(new Error(`Job timed out after ${timeoutMs}ms`));
                    },
                    { once: true }
                );
            }),
        ]);

        const outcome = await completeJob(pool, { jobId: job.id, workerId: WORKER_ID, attempt: job.attempt });
        if (outcome.fenced) {
            console.warn(`[${WORKER_ID}] Completion for job ${job.id} rejected by fencing (lease was reclaimed).`);
        } else {
            console.log(`[${WORKER_ID}] Job ${job.id} COMPLETED`);
        }
    } catch (err) {
        const retryable = !(err instanceof NonRetryableError);
        const outcome = await failJob(pool, {
            jobId: job.id,
            workerId: WORKER_ID,
            attempt: job.attempt,
            error: err,
            retryable,
        });
        if (outcome.fenced) {
            console.warn(
                `[${WORKER_ID}] Failure handling for job ${job.id} rejected by fencing (lease was reclaimed).`
            );
        } else if (outcome.deadLettered) {
            console.error(`[${WORKER_ID}] Job ${job.id} moved to DEAD: ${err.message}`);
        } else {
            console.warn(`[${WORKER_ID}] Job ${job.id} scheduled for retry in ${outcome.delayMs}ms: ${err.message}`);
        }
    } finally {
        clearTimeout(timeoutTimer);
        clearInterval(leaseTimer);
        activeJobIds.delete(job.id);
        running.delete(job.id);
    }
}

async function lane() {
    while (!shuttingDown) {
        let job;
        try {
            job = await claimNextJob(pool, { workerId: WORKER_ID, leaseMs: LEASE_MS });
        } catch (err) {
            console.error(`[${WORKER_ID}] claim error:`, err);
            await sleep(POLL_INTERVAL_MS);
            continue;
        }

        if (!job) {
            await sleep(POLL_INTERVAL_MS);
            continue;
        }

        const jobPromise = processJob(job);
        inFlight.add(jobPromise);
        try {
            await jobPromise;
        } finally {
            inFlight.delete(jobPromise);
        }
    }
}

async function reaperTick() {
    try {
        const reaped = await reapExpiredLeases(pool);
        if (reaped.length > 0) {
            console.log(
                `[${WORKER_ID}] Reaper reclaimed ${reaped.length} job(s):`,
                reaped.map((r) => r.jobId)
            );
        }
        await markDeadWorkers(pool, { thresholdMs: DEAD_WORKER_THRESHOLD_MS });
    } catch (err) {
        console.error(`[${WORKER_ID}] reaper tick failed:`, err);
    }
}

async function shutdown(signal, reaperInterval, heartbeatInterval, lanes) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
        `[${WORKER_ID}] Received ${signal}. Stopping new claims, waiting up to ${SHUTDOWN_GRACE_MS}ms for ${inFlight.size} in-flight job(s)...`
    );
    clearInterval(reaperInterval);
    clearInterval(heartbeatInterval);

    const grace = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
    await Promise.race([Promise.all(lanes), grace]);

    if (running.size > 0) {
        console.warn(
            `[${WORKER_ID}] Grace period elapsed with ${running.size} job(s) still running; releasing them back to the queue.`
        );
        // Release BEFORE aborting: abort makes processJob take its failure
        // path, and once the row is no longer ours that path is fenced off
        // instead of also scheduling a (backoff-delayed) retry.
        for (const { job, controller } of running.values()) {
            try {
                const outcome = await releaseJob(pool, {
                    jobId: job.id,
                    workerId: WORKER_ID,
                    attempt: job.attempt,
                    reason: 'shutdown',
                });
                console.log(`[${WORKER_ID}] Released job ${job.id} (reason=shutdown, fenced=${outcome.fenced})`);
            } catch (err) {
                console.error(`[${WORKER_ID}] failed to release job ${job.id}; its lease will expire instead:`, err);
            }
            controller.abort();
        }
    }

    try {
        await deregisterWorker(pool, { id: WORKER_ID });
    } catch (err) {
        console.error(`[${WORKER_ID}] failed to deregister cleanly:`, err);
    }
    await pool.end();
    console.log(`[${WORKER_ID}] Shutdown complete.`);
    process.exit(0);
}

async function start() {
    await registerWorker(pool, { id: WORKER_ID, hostname: os.hostname(), pid: process.pid, version: '1.0.0' });
    console.log(`Worker [${WORKER_ID}] started. concurrency=${CONCURRENCY} leaseMs=${LEASE_MS}`);

    const reaperInterval = setInterval(reaperTick, REAP_INTERVAL_MS);
    reaperTick();

    // Independent of job execution: an idle worker (nothing claimed right
    // now) must still heartbeat, or markDeadWorkers() would wrongly mark a
    // perfectly healthy, idle worker DEAD.
    const heartbeatInterval = setInterval(() => {
        const currentJobId = activeJobIds.values().next().value || null;
        heartbeatWorker(pool, { id: WORKER_ID, currentJobId }).catch((err) => {
            console.error(`[${WORKER_ID}] worker heartbeat failed:`, err);
        });
    }, HEARTBEAT_INTERVAL_MS);

    const lanes = Array.from({ length: CONCURRENCY }, () => lane());

    process.on('SIGTERM', () => shutdown('SIGTERM', reaperInterval, heartbeatInterval, lanes));
    process.on('SIGINT', () => shutdown('SIGINT', reaperInterval, heartbeatInterval, lanes));
}

start();
