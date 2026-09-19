// Retry budget vs fencing counter (docs/AUDIT.md): infrastructure events must
// not consume a job's retry budget; only handler failures do.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, resetDb, insertJob, getJob, events } from '../chaos/helpers.js';
import { claimNextJob, completeJob, failJob, releaseJob, recoverJob, extendLease } from '../../src/jobs/repository.js';

beforeEach(resetDb);
afterAll(() => pool.end());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function claim(workerId, leaseMs = 60000) {
    const job = await claimNextJob(pool, { workerId, leaseMs });
    expect(job).not.toBeNull();
    return job;
}

describe('retry budget', () => {
    it('shutdown releases do not consume failure budget', async () => {
        const id = await insertJob({ maxAttempts: 2 });
        for (let i = 1; i <= 5; i++) {
            const job = await claim('w1');
            expect(job.attempt).toBe(i); // fencing counter keeps rising...
            expect((await releaseJob(pool, { jobId: id, workerId: 'w1', attempt: i, reason: 'shutdown' })).fenced).toBe(
                false
            );
        }
        const row = await getJob(id);
        expect(row.status).toBe('RETRY_SCHEDULED');
        expect(row.failure_count).toBe(0); // ...but the budget is untouched
        expect(row.attempt).toBe(5); // 5 attempts used > max_attempts (2): budget != attempt
    });

    it('lease-expiry recoveries do not consume failure budget, but are capped (poison quarantine)', async () => {
        const id = await insertJob({ maxAttempts: 2 });
        const cap = 3;
        for (let i = 1; i <= cap; i++) {
            const job = await claim('crashy', 50);
            await sleep(120); // lease expires: the worker "crashed"
            const out = await recoverJob(pool, {
                jobId: id,
                workerId: 'crashy',
                attempt: job.attempt,
                maxRecoveries: cap,
            });
            expect(out.fenced).toBe(false);
            expect(out.deadLettered).toBe(false);
            expect((await getJob(id)).failure_count).toBe(0);
        }
        const job = await claim('crashy', 50);
        await sleep(120);
        const out = await recoverJob(pool, { jobId: id, workerId: 'crashy', attempt: job.attempt, maxRecoveries: cap });
        expect(out.deadLettered).toBe(true);
        const row = await getJob(id);
        expect(row.status).toBe('DEAD');
        expect(row.last_error).toMatch(/poison/);
        const trail = await events(id);
        expect(trail[trail.length - 1].reason).toBe('poison_quarantined');
    });

    it('handler failures DO consume budget: max_attempts=2 means 2 failures then DEAD', async () => {
        const id = await insertJob({ maxAttempts: 2 });
        // Prior infrastructure noise first, to prove it is ignored.
        const noisy = await claim('w1');
        await releaseJob(pool, { jobId: id, workerId: 'w1', attempt: noisy.attempt, reason: 'shutdown' });

        const first = await claim('w1');
        const r1 = await failJob(pool, {
            jobId: id,
            workerId: 'w1',
            attempt: first.attempt,
            error: new Error('boom 1'),
            retryable: true,
            random: () => 0,
        });
        expect(r1.deadLettered).toBe(false);
        expect((await getJob(id)).failure_count).toBe(1);

        await sleep(50); // backoff with random()=0 is 0ms
        const second = await claim('w1');
        const r2 = await failJob(pool, {
            jobId: id,
            workerId: 'w1',
            attempt: second.attempt,
            error: new Error('boom 2'),
            retryable: true,
            random: () => 0,
        });
        expect(r2.deadLettered).toBe(true);
        const row = await getJob(id);
        expect(row.status).toBe('DEAD');
        expect(row.failure_count).toBe(2);
        expect(row.attempt).toBe(3);
    });

    it('a non-retryable failure goes straight to DEAD', async () => {
        const id = await insertJob({ maxAttempts: 5 });
        const job = await claim('w1');
        const out = await failJob(pool, {
            jobId: id,
            workerId: 'w1',
            attempt: job.attempt,
            error: new Error('bad payload'),
            retryable: false,
        });
        expect(out.deadLettered).toBe(true);
        expect((await events(id)).pop().reason).toBe('non_retryable_error');
    });
});

describe('backoff is really applied to run_at', () => {
    it('schedules the retry base*2^(failures-1)*random ms in the future (regression: was 1000x too short)', async () => {
        const id = await insertJob({ maxAttempts: 5 });
        await pool.query('UPDATE jobs SET backoff_base_ms = 20000, backoff_max_ms = 600000 WHERE id = $1', [id]);
        const job = await claim('w1');
        await failJob(pool, {
            jobId: id,
            workerId: 'w1',
            attempt: job.attempt,
            error: new Error('x'),
            retryable: true,
            random: () => 0.5, // 0.5 * 20000ms = 10000ms
        });
        const { rows } = await pool.query(
            'SELECT extract(epoch FROM (run_at - now())) * 1000 AS delay_ms FROM jobs WHERE id = $1',
            [id]
        );
        expect(Number(rows[0].delay_ms)).toBeGreaterThan(9000);
        expect(Number(rows[0].delay_ms)).toBeLessThan(10500);
    });
});

describe('reaper cannot steal a live lease', () => {
    it('recoverJob is fenced when the lease is still valid', async () => {
        const id = await insertJob({});
        const job = await claim('w1', 60000);
        const out = await recoverJob(pool, { jobId: id, workerId: 'w1', attempt: job.attempt, maxRecoveries: 10 });
        expect(out).toEqual({ fenced: true });
        expect((await getJob(id)).status).toBe('PROCESSING');
    });

    it('a heartbeat that lands after the reaper scanned wins (stale scan result)', async () => {
        const id = await insertJob({});
        const job = await claim('w1', 50);
        await sleep(120);
        // Reaper's scan saw an expired lease here; then the worker heartbeats before the reaper acts.
        expect(await extendLease(pool, { jobId: id, workerId: 'w1', attempt: job.attempt, leaseMs: 60000 })).toBe(true);
        const out = await recoverJob(pool, { jobId: id, workerId: 'w1', attempt: job.attempt, maxRecoveries: 10 });
        expect(out).toEqual({ fenced: true });
        const done = await completeJob(pool, { jobId: id, workerId: 'w1', attempt: job.attempt });
        expect(done.fenced).toBe(false);
    });
});

describe('schema guard', () => {
    it('rejects a PROCESSING row that has no lease (reaper could never see it)', async () => {
        const id = await insertJob({});
        await expect(pool.query("UPDATE jobs SET status = 'PROCESSING' WHERE id = $1", [id])).rejects.toThrow(
            /jobs_processing_has_lease/
        );
    });
});
