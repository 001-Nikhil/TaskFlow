// Redis is not on the correctness path: submission and processing are both
// Postgres-only. These tests prove it by wiping and then stopping Redis while
// jobs flow through the real API and a real worker.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'child_process';
import { app } from '../../src/api.js';
import redis from '../../src/redis.js';
import { pool, spawnWorker, hardKill, resetDb, getJob, waitFor } from './helpers.js';

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
let worker;

async function submit() {
    const res = await request(app)
        .post('/jobs')
        .set('x-api-key', process.env.API_KEY)
        .send({ type: 'send_email', payload: { to: 'chaos@test.com' } });
    return res;
}

beforeEach(async () => {
    await resetDb();
});

afterAll(async () => {
    if (worker) hardKill(worker);
    try {
        docker('start', 'taskflow_redis'); // never leave the dev stack broken
    } catch {
        /* already running */
    }
    await pool.end();
    redis.disconnect();
});

describe('chaos: Redis flush / outage', () => {
    it('FLUSHALL loses nothing: jobs are still accepted and processed', async () => {
        worker = spawnWorker();
        await redis.flushall();
        const res = await submit();
        expect(res.status).toBe(202);
        await waitFor(async () => (await getJob(res.body.jobId)).status === 'COMPLETED', {
            label: 'job completion after flush',
        });
    }, 30000);

    it('Redis fully stopped: API still accepts jobs, worker still completes them, /ready reports the outage', async () => {
        docker('stop', 'taskflow_redis');
        try {
            const res = await submit();
            expect(res.status).toBe(202);
            await waitFor(async () => (await getJob(res.body.jobId)).status === 'COMPLETED', {
                label: 'completion during outage',
            });

            const ready = await request(app).get('/ready');
            console.log('/ready during outage:', ready.status, JSON.stringify(ready.body));
            expect(ready.status).toBe(503); // honest: dependency is down...
            const health = await request(app).get('/health');
            expect(health.status).toBe(200); // ...but the process is alive
        } finally {
            docker('start', 'taskflow_redis');
        }
    }, 60000);
});
