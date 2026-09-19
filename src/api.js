const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { installProcessGuards } = require('./processGuards');
const config = require('./config');
const pool = require('./db');
const redis = require('./redis');
const { KNOWN_JOB_TYPES } = require('./jobs/handlers');

installProcessGuards();

const app = express();

// 256 KB per CLAUDE.md Section 3.13. express-json's default error for an
// oversized body is a bare "PayloadTooLargeError"; the error handler below
// reshapes it (and JSON parse errors) into a consistent JSON response.
app.use(express.json({ limit: '256kb' }));

app.use(
    rateLimit({
        windowMs: 60_000,
        limit: 100,
        standardHeaders: true,
        legacyHeaders: false,
    })
);

function requireApiKey(req, res, next) {
    if (req.get('x-api-key') !== config.apiKey) {
        return res.status(401).json({ error: 'Missing or invalid API key' });
    }
    next();
}

const jobSubmissionSchema = z.object({
    type: z.string().min(1, 'type is required'),
    payload: z.record(z.string(), z.unknown()).optional().default({}),
    idempotencyKey: z.string().min(1).max(255).optional(),
});

const uuidSchema = z.string().uuid();

app.post('/jobs', requireApiKey, async (req, res) => {
    const parsed = jobSubmissionSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const { type, payload, idempotencyKey } = parsed.data;

    if (!KNOWN_JOB_TYPES.includes(type)) {
        return res.status(400).json({ error: `Unknown job type: ${type}`, knownTypes: KNOWN_JOB_TYPES });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // ON CONFLICT DO NOTHING never fires for a NULL idempotency_key
        // (Postgres treats every NULL as distinct), so a submission with no
        // key always inserts. With a key, a concurrent duplicate resolves
        // atomically here instead of the old check-then-insert race.
        const inserted = await client.query(
            `INSERT INTO jobs (type, payload, idempotency_key, status)
             VALUES ($1, $2, $3, 'QUEUED')
             ON CONFLICT (idempotency_key) DO NOTHING
             RETURNING *`,
            [type, payload, idempotencyKey || null]
        );

        if (inserted.rows.length === 1) {
            const job = inserted.rows[0];
            await client.query(
                `INSERT INTO job_events (job_id, from_status, to_status, reason) VALUES ($1, NULL, $2, 'submitted')`,
                [job.id, job.status]
            );
            await client.query('COMMIT');
            return res.status(202).json({ jobId: job.id, status: job.status });
        }

        // Conflict: a job with this idempotency key already exists.
        const existing = await client.query('SELECT id, status FROM jobs WHERE idempotency_key = $1', [idempotencyKey]);
        await client.query('COMMIT');
        return res.status(200).json({
            message: 'Job already accepted (idempotent submission)',
            jobId: existing.rows[0].id,
            status: existing.rows[0].status,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('failed to submit job', err);
        return res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

app.get('/jobs/:id', requireApiKey, async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.id);
    if (!parsedId.success) {
        return res.status(400).json({ error: 'Invalid job id: must be a UUID' });
    }

    try {
        const result = await pool.query('SELECT * FROM jobs WHERE id = $1', [parsedId.data]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }
        return res.json(result.rows[0]);
    } catch (err) {
        console.error('Failed to fetch job', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/ready', async (req, res) => {
    const checks = { postgres: false, redis: false };
    try {
        await pool.query('SELECT 1');
        checks.postgres = true;
    } catch (err) {
        console.error('readiness: postgres check failed', err);
    }
    try {
        checks.redis = (await redis.ping()) === 'PONG';
    } catch (err) {
        console.error('readiness: redis check failed', err);
    }
    const ready = checks.postgres && checks.redis;
    res.status(ready ? 200 : 503).json({ ready, checks });
});

// Reshapes express's built-in JSON body-parser errors (malformed JSON,
// over the 256KB limit) into the same error-response shape as the rest of
// the API instead of leaking express's default HTML/error format.
app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request body too large (max 256KB)' });
    }
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Malformed JSON body' });
    }
    next(err);
});

function start() {
    const server = app.listen(config.port, () => {
        console.log(`Server is running on port ${config.port}`);
    });

    let shuttingDown = false;
    function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`Received ${signal}, closing server...`);
        server.close(async () => {
            await pool.end();
            redis.disconnect();
            console.log('Shutdown complete.');
            process.exit(0);
        });
        // Force-exit if connections don't drain in time.
        setTimeout(() => process.exit(1), 10_000).unref();
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    return server;
}

if (require.main === module) {
    start();
}

module.exports = { app, start };
