const express = require('express');
const { installProcessGuards } = require('./processGuards');
const db = require('./db');
const redis = require('./redis');

installProcessGuards();

const app = express();
app.use(express.json());

app.post('/jobs', async (req, res) => {
    const {type, payload, idempotencyKey} = req.body;

    if (!type) {
        return res.status(400).json({
            error: "Job type is required"
        })
    }
    try {
        // Check for existing job with the same idempotency key
        if (idempotencyKey) {
            const existingJob = await db.query('SELECT * FROM jobs WHERE idempotency_key = $1', [idempotencyKey]);

            if (existingJob.rows.length > 0) {
                console.log(`Duplicate submission blocked for idempotency key: ${idempotencyKey}`);
                return res.status(200).json({
                    message: 'Job already accepted (Idempotent submission)',
                    jobid: existingJob.rows[0].id,
                    status: existingJob.rows[0].status,
                })
            }
        }
        const insertQuery = `INSERT INTO jobs (type, payload, status, idempotency_key) VALUES ($1, $2, 'PENDING', $3) RETURNING *`;
        const pgRes = await db.query(insertQuery, [type, payload || {}, idempotencyKey || null]);
        const job = pgRes.rows[0];

        await redis.lpush('queue:default', job.id);

        await db.query(`UPDATE jobs SET status = 'QUEUED', updated_at = NOW() WHERE id = $1`, [job.id]);

        return res.status(202).json({
            message: 'Job submitted successfully',
            jobId: job.id,
            status: 'QUEUED',
        });
    }
    catch (err) {
        if (err.code === '23505') { // Unique violation error code for PostgreSQL
            return res.status(409).json({
                error: 'Concurrent duplicate request detected.'
            })
        }
        console.error('failed to submit job', err);
        return res.status(500).json({
            error: 'Internal server error'
        });
    }
});


app.get('/jobs/:id', async (req, res) => {
    const {id} = req.params;

    try {
        const result = await db.query('SELECT * FROM jobs WHERE id = $1', [id]);

        if (result.rows.length == 0) {
            return res.status(404).json({
                error: 'Job not found'
            })
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error('Failed to fetch job', err);
        return res.status(500).json({
            error: 'Internal server error'
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>{
    console.log(`Server is running on port ${PORT}`);
})