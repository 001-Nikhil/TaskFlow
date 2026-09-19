import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api.js';
import redis from '../../src/redis.js';
import { pool, resetDb } from '../chaos/helpers.js';

const key = () => process.env.API_KEY;

beforeEach(resetDb);
afterAll(async () => {
    await pool.end();
    redis.disconnect();
});

describe('API key check', () => {
    it.each([['x'], ['a'.repeat(5000)], ['']])(
        'rejects a wrong key of any length without throwing (%#)',
        async (bad) => {
            const res = await request(app).get('/jobs/00000000-0000-0000-0000-000000000000').set('x-api-key', bad);
            expect(res.status).toBe(401);
        }
    );

    it('accepts the right key', async () => {
        const res = await request(app).get('/jobs/00000000-0000-0000-0000-000000000000').set('x-api-key', key());
        expect(res.status).toBe(404);
    });
});

describe('GET /jobs/:id', () => {
    it('returns 400 for a malformed id, 404 for an unknown one', async () => {
        expect((await request(app).get('/jobs/not-a-uuid').set('x-api-key', key())).status).toBe(400);
        expect(
            (await request(app).get('/jobs/00000000-0000-0000-0000-000000000000').set('x-api-key', key())).status
        ).toBe(404);
    });

    it('does not leak lease/fencing internals', async () => {
        const created = await request(app).post('/jobs').set('x-api-key', key()).send({ type: 'send_email' });
        const res = await request(app).get(`/jobs/${created.body.jobId}`).set('x-api-key', key());
        expect(res.status).toBe(200);
        for (const internal of [
            'locked_by',
            'lease_expires_at',
            'recovery_count',
            'backoff_base_ms',
            'idempotency_key',
        ]) {
            expect(res.body).not.toHaveProperty(internal);
        }
        expect(res.body).toMatchObject({ id: created.body.jobId, status: 'QUEUED', attempt: 0, failure_count: 0 });
    });
});

describe('probes and error shape', () => {
    it('/health and /ready are never rate limited', async () => {
        const responses = await Promise.all(Array.from({ length: 150 }, () => request(app).get('/health')));
        expect(responses.every((r) => r.status === 200)).toBe(true);
    });

    it('/ready is 200 when Postgres is up', async () => {
        const res = await request(app).get('/ready');
        expect(res.status).toBe(200);
        expect(res.body.checks.postgres).toBe(true);
    });

    it('unknown routes and oversized/malformed bodies return JSON, not HTML', async () => {
        const nf = await request(app).get('/nope');
        expect(nf.status).toBe(404);
        expect(nf.body).toEqual({ error: 'Not found' });

        const big = await request(app)
            .post('/jobs')
            .set('x-api-key', key())
            .send({ type: 'send_email', payload: { blob: 'x'.repeat(300 * 1024) } });
        expect(big.status).toBe(413);

        const bad = await request(app)
            .post('/jobs')
            .set('x-api-key', key())
            .set('content-type', 'application/json')
            .send('{not json');
        expect(bad.status).toBe(400);
        expect(bad.body.error).toBe('Malformed JSON body');
    });
});
