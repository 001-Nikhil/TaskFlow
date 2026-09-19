// Chaos tests from CLAUDE.md Section 9: kill -9, lost ack, zombie/fencing.
// Run with: npm run test:chaos  (needs `docker compose up -d postgres redis`)
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, spawnWorker, hardKill, resetDb, insertJob, getJob, events, waitFor, tmpLog, effectCount } from './helpers.js';
import { claimNextJob, completeJob, failJob, extendLease, reapExpiredLeases } from '../../src/jobs/repository.js';
import { once } from '../../src/jobs/effects.js';

const workers = [];
const track = (w) => {
    workers.push(w);
    return w;
};
function killAll() {
    while (workers.length) {
        try {
            hardKill(workers.pop());
        } catch {
            /* already gone */
        }
    }
}

beforeEach(async () => {
    killAll();
    await resetDb();
});

afterAll(async () => {
    killAll();
    await pool.end();
});

// Short lease so tests are quick; heartbeat comfortably inside the lease.
const FAST = { LEASE_MS: '1500', HEARTBEAT_INTERVAL_MS: '400' };

describe('chaos: kill -9 mid-job', () => {
    it('reaper reclaims the orphaned job; it completes once and the side effect applies once', async () => {
        const log = tmpLog();
        const id = await insertJob({ payload: { logFile: log, beforeMs: 3000, afterMs: 0 } });

        const victim = track(spawnWorker(FAST));
        await waitFor(async () => (await getJob(id)).status === 'PROCESSING', { label: 'victim to claim job' });
        const victimId = (await getJob(id)).locked_by;

        hardKill(victim); // no handlers run, no cleanup: a real crash
        await victim.exited;
        expect((await getJob(id)).status).toBe('PROCESSING'); // orphaned; nothing has noticed yet

        track(spawnWorker(FAST)); // healthy worker: its reaper + lanes must rescue the job
        await waitFor(async () => (await getJob(id)).status === 'COMPLETED', { label: 'completion after reap' });

        const job = await getJob(id);
        expect(job.attempt).toBe(2); // attempt 1 died with the victim, attempt 2 finished
        expect(job.locked_by).toBeNull();
        expect(effectCount(log)).toBe(1); // crash was BEFORE the effect -> exactly one effect

        const trail = await events(id);
        console.log('kill -9 event trail:\n' + trail.map((e) => `  ${e.from_status}->${e.to_status} attempt=${e.attempt} (${e.reason})`).join('\n'));
        expect(trail.some((e) => e.to_status === 'RETRY_SCHEDULED' && e.worker_id === victimId)).toBe(true);
        expect(trail[trail.length - 1].to_status).toBe('COMPLETED');
    }, 60000);
});

describe('chaos: lost ack', () => {
    it('effect ran but worker died before COMPLETED; redelivery does NOT repeat the effect', async () => {
        const log = tmpLog();
        // beforeMs=0: effect fires at once; afterMs keeps the job in flight
        // afterwards so we can kill between "effect done" and "ack written".
        const id = await insertJob({ payload: { logFile: log, beforeMs: 0, afterMs: 5000 } });

        const victim = track(spawnWorker(FAST));
        await waitFor(() => effectCount(log) === 1, { label: 'effect to be applied' });
        hardKill(victim);
        await victim.exited;
        expect((await getJob(id)).status).toBe('PROCESSING'); // the ack never happened

        track(spawnWorker(FAST));
        await waitFor(async () => (await getJob(id)).status === 'COMPLETED', { label: 'redelivery completion' });

        expect((await getJob(id)).attempt).toBe(2); // delivered twice...
        expect(effectCount(log)).toBe(1); // ...effect happened once
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM effects WHERE job_id = $1', [id]);
        expect(rows[0].n).toBe(1);
    }, 60000);
});

describe('chaos: zombie worker (fencing)', () => {
    it('a worker whose lease was reclaimed cannot complete, fail, or extend the job', async () => {
        const id = await insertJob({ payload: {} });

        const a = await claimNextJob(pool, { workerId: 'zombie-A', leaseMs: 200 });
        expect(a.id).toBe(id);
        expect(a.attempt).toBe(1);

        await new Promise((r) => setTimeout(r, 400)); // A "freezes"; lease expires
        const reaped = await reapExpiredLeases(pool);
        expect(reaped.map((r) => r.jobId)).toEqual([id]);

        await new Promise((r) => setTimeout(r, 300)); // backoff (<=200ms) elapses
        const b = await claimNextJob(pool, { workerId: 'healthy-B', leaseMs: 30000 });
        expect(b.id).toBe(id);
        expect(b.attempt).toBe(2);

        // Zombie A wakes up holding its stale token (attempt 1).
        expect(await completeJob(pool, { jobId: id, workerId: 'zombie-A', attempt: 1 })).toEqual({ fenced: true });
        expect(
            await failJob(pool, { jobId: id, workerId: 'zombie-A', attempt: 1, error: new Error('x'), retryable: false })
        ).toEqual({ fenced: true });
        expect(await extendLease(pool, { jobId: id, workerId: 'zombie-A', attempt: 1, leaseMs: 60000 })).toBe(false);
        // The token, not the name, is what fences: right owner + stale attempt is rejected too.
        expect(await completeJob(pool, { jobId: id, workerId: 'healthy-B', attempt: 1 })).toEqual({ fenced: true });

        const mid = await getJob(id);
        expect(mid.status).toBe('PROCESSING'); // untouched by all of the above
        expect(mid.locked_by).toBe('healthy-B');

        const done = await completeJob(pool, { jobId: id, workerId: 'healthy-B', attempt: 2 });
        expect(done.fenced).toBe(false);
        expect((await getJob(id)).status).toBe('COMPLETED');
    }, 20000);

    it("zombie's duplicate side effect is deduplicated by the effects ledger", async () => {
        const id = await insertJob({ payload: {} });
        let runs = 0;
        await once(pool, id, 'send', async () => runs++); // zombie's run
        const second = await once(pool, id, 'send', async () => runs++); // redelivered worker
        expect(second.alreadyRan).toBe(true);
        expect(runs).toBe(1);
    });
});
