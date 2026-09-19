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
    it('jobs already QUEUED survive FLUSHALL and are processed afterwards (no reconciler needed: Postgres is the queue)', async () => {
        const ids = [];
        for (let i = 0; i < 5; i++) {
            const res = await submit(); // no worker running yet: all five sit QUEUED
            expect(res.status).toBe(202);
            ids.push(res.body.jobId);
        }
        await redis.flushall();
        expect(await redis.dbsize()).toBe(0);
        worker = spawnWorker();
        for (const id of ids) {
            await waitFor(async () => (await getJob(id)).status === 'COMPLETED', { label: 'queued job after flush' });
        }
    }, 60000);

    it('FLUSHALL loses nothing: jobs are still accepted and processed', async () => {
        worker = spawnWorker();
        await redis.flushall();
        const res = await submit();
        expect(res.status).toBe(202);
        await waitFor(async () => (await getJob(res.body.jobId)).status === 'COMPLETED', {
            label: 'job completion after flush',
        });
    }, 30000);

    it('Redis fully stopped: API still accepts jobs, worker still completes them, /ready reports degraded (not down)', async () => {
        docker('stop', 'taskflow_redis');
        try {
            const res = await submit();
            expect(res.status).toBe(202);
            await waitFor(async () => (await getJob(res.body.jobId)).status === 'COMPLETED', {
                label: 'completion during outage',
            });

            const ready = await request(app).get('/ready');
            console.log('/ready during outage:', ready.status, JSON.stringify(ready.body));
            expect(ready.status).toBe(200); // Redis is off the correctness path: still ready...
            expect(ready.body).toMatchObject({ ready: true, degraded: true, checks: { postgres: true, redis: false } }); // ...but honestly reported
            const health = await request(app).get('/health');
            expect(health.status).toBe(200);
        } finally {
            docker('start', 'taskflow_redis');
        }
    }, 60000);
});
