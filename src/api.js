const crypto = require('crypto');
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

// Probes are registered BEFORE the rate limiter: an orchestrator or load
// balancer polling /health from one IP must never be throttled into looking
// unhealthy.
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// ioredis queues commands while disconnected and retries forever, so
// redis.ping() against a dead Redis never settles. A readiness probe must
// answer promptly instead of hanging, so every dependency check is bounded.
const READY_TIMEOUT_MS = 2000;
function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Ready = "can serve traffic correctly". That depends on Postgres only: jobs
// are submitted to and claimed from Postgres, so Redis being down does not
// change correctness (docs/DESIGN.md). Failing readiness for it would make a
// load balancer pull every healthy API instance for no reason, so Redis is
// reported as informational (`degraded`) instead.
app.get('/ready', async (req, res) => {
    const checks = { postgres: false, redis: false };
    try {
        await withTimeout(pool.query('SELECT 1'), READY_TIMEOUT_MS);
        checks.postgres = true;
    } catch (err) {
        console.error('readiness: postgres check failed:', err.message);
    }
    try {
        checks.redis = (await withTimeout(redis.ping(), READY_TIMEOUT_MS)) === 'PONG';
    } catch (err) {
        console.error('readiness: redis check failed:', err.message);
    }
    const ready = checks.postgres;
    res.status(ready ? 200 : 503).json({ ready, degraded: ready && !checks.redis, checks });
});

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

// Compare digests, not the raw strings: timingSafeEqual throws on unequal
// lengths, and comparing fixed-length hashes also hides the key's length.
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function requireApiKey(req, res, next) {
    if (!safeEqual(req.get('x-api-key') || '', config.apiKey)) {
        return res.status(401).json({ error: 'Missing or invalid API key' });
    }
    next();
}

// Columns a client may see. Excludes lease/fencing internals (locked_by,
// lease_expires_at, recovery_count) and per-job tuning knobs.
const PUBLIC_JOB_COLUMNS = `id, type, payload, status, priority_rank, attempt, failure_count, max_attempts,
    last_error, run_at, created_at, updated_at, started_at, completed_at`;

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
        // If the connection itself died, ROLLBACK fails too; that must not mask the response.
        await client.query('ROLLBACK').catch(() => {});
        console.error('failed to submit job', err.message);
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
        const result = await pool.query(`SELECT ${PUBLIC_JOB_COLUMNS} FROM jobs WHERE id = $1`, [parsedId.data]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }
        return res.json(result.rows[0]);
    } catch (err) {
        console.error('Failed to fetch job', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
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

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Last resort: never leak an HTML error page or stack trace to a client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('unhandled request error', err);
    res.status(500).json({ error: 'Internal server error' });
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
