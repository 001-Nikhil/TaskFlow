// Requires a live Postgres/Redis (the docker-compose dev stack) reachable
// via .env's DATABASE_URL/REDIS_URL - this is an integration test, not a
// mock. Run with: npm run test:integration
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api.js';
import pool from '../../src/db.js';
import redis from '../../src/redis.js';

describe('POST /jobs idempotent submission', () => {
    const apiKey = process.env.API_KEY;

    beforeEach(async () => {
        await pool.query('DELETE FROM job_events');
        await pool.query('DELETE FROM jobs');
    });

    afterAll(async () => {
        await pool.end();
        redis.disconnect();
    });

    it('rejects requests without a valid API key', async () => {
        const res = await request(app).post('/jobs').send({ type: 'send_email' });
        expect(res.status).toBe(401);
    });

    it('rejects an unknown job type', async () => {
        const res = await request(app)
            .post('/jobs')
            .set('x-api-key', apiKey)
            .send({ type: 'not_a_real_type' });
        expect(res.status).toBe(400);
    });

    it('N concurrent identical submissions create exactly 1 job', async () => {
        const idempotencyKey = `race-${Date.now()}`;
        const N = 10;

        const responses = await Promise.all(
            Array.from({ length: N }, () =>
                request(app)
                    .post('/jobs')
                    .set('x-api-key', apiKey)
                    .send({ type: 'send_email', payload: { to: 'race@test.com' }, idempotencyKey })
            )
        );

        const jobIds = new Set(responses.map((r) => r.body.jobId));
        expect(jobIds.size).toBe(1);

        const { rows } = await pool.query('SELECT count(*)::int AS count FROM jobs WHERE idempotency_key = $1', [
            idempotencyKey,
        ]);
        expect(rows[0].count).toBe(1);

        const statuses = responses.map((r) => r.status).sort();
        // Exactly one submission wins the INSERT (202); the rest see the
        // conflict and get the existing job back (200).
        expect(statuses.filter((s) => s === 202)).toHaveLength(1);
        expect(statuses.filter((s) => s === 200)).toHaveLength(N - 1);
    });

    it('two different idempotency keys create two separate jobs', async () => {
        const a = await request(app)
            .post('/jobs')
            .set('x-api-key', apiKey)
            .send({ type: 'send_email', idempotencyKey: 'key-a' });
        const b = await request(app)
            .post('/jobs')
            .set('x-api-key', apiKey)
            .send({ type: 'send_email', idempotencyKey: 'key-b' });

        expect(a.body.jobId).not.toBe(b.body.jobId);
    });

    it('submissions with no idempotency key are never deduplicated', async () => {
        const a = await request(app).post('/jobs').set('x-api-key', apiKey).send({ type: 'send_email' });
        const b = await request(app).post('/jobs').set('x-api-key', apiKey).send({ type: 'send_email' });

        expect(a.body.jobId).not.toBe(b.body.jobId);
    });
});
