// Chaos: Postgres connection drops mid-job (CLAUDE.md Section 9 #4) and lease
// loss while a handler is running. Real worker process, real Postgres.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, spawnWorker, hardKill, resetDb, insertJob, getJob, waitFor, tmpLog, effectCount } from './helpers.js';

const APP_NAME = 'taskflow-chaos-worker';
const FAST = { LEASE_MS: '1500', HEARTBEAT_INTERVAL_MS: '400', PGAPPNAME: APP_NAME };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Severs every Postgres connection owned by the worker under test (tagged via
// PGAPPNAME) exactly as a network drop or a DB failover would.
async function dropWorkerConnections() {
    const { rows } = await pool.query(
        `SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity
         WHERE application_name = $1 AND pid <> pg_backend_pid()`,
        [APP_NAME]
    );
    return rows.length;
}

beforeEach(async () => {
    killAll();
    await resetDb();
});
afterAll(async () => {
    killAll();
    await pool.end();
});

describe('chaos: Postgres connection drop mid-job', () => {
    it('one drop while the handler runs: job completes once, effect once, worker survives', async () => {
        const log = tmpLog();
        const id = await insertJob({ payload: { logFile: log, beforeMs: 2000, afterMs: 0 } });
        const w = track(spawnWorker(FAST));
        await waitFor(async () => (await getJob(id)).status === 'PROCESSING', { label: 'claim' });

        const dropped = await dropWorkerConnections();
        expect(dropped).toBeGreaterThan(0);

        await waitFor(async () => (await getJob(id)).status === 'COMPLETED', { label: 'completion after drop' });
        const { rows } = await pool.query(
            "SELECT count(*)::int AS n FROM job_events WHERE job_id = $1 AND to_status = 'COMPLETED'",
            [id]
        );
        expect(rows[0].n).toBe(1); // no double completion
        expect(effectCount(log)).toBe(1); // no double effect
        expect(w.exitCode).toBeNull(); // worker process is still alive
        expect(w.logs).not.toMatch(/Unhandled promise rejection/);
    }, 60000);

    it('connections dropped repeatedly for seconds: never completes twice, never repeats the effect, worker survives', async () => {
        const log = tmpLog();
        const id = await insertJob({ payload: { logFile: log, beforeMs: 1500, afterMs: 1500 } });
        const w = track(spawnWorker(FAST));
        await waitFor(async () => (await getJob(id)).status === 'PROCESSING', { label: 'claim' });

        const stormEnds = Date.now() + 5000;
        while (Date.now() < stormEnds) {
            await dropWorkerConnections();
            await sleep(200);
        }

        await waitFor(async () => (await getJob(id)).status === 'COMPLETED', {
            timeoutMs: 40000,
            label: 'completion after connection storm',
        });
        const { rows } = await pool.query(
            "SELECT count(*)::int AS n FROM job_events WHERE job_id = $1 AND to_status = 'COMPLETED'",
            [id]
        );
        expect(rows[0].n).toBe(1);
        expect(effectCount(log)).toBe(1);
        expect(w.exitCode).toBeNull();
        expect(w.logs).not.toMatch(/Unhandled promise rejection/);
    }, 90000);
});

describe('chaos: lease lost while the handler is running', () => {
    it('worker notices at its next heartbeat and aborts the handler: the stale run produces no side effect', async () => {
        const log = tmpLog();
        const id = await insertJob({ payload: { logFile: log, beforeMs: 4000, afterMs: 0 } });
        const w = track(spawnWorker(FAST));
        await waitFor(async () => (await getJob(id)).status === 'PROCESSING', { label: 'claim' });

        // Someone else takes the job away (what the reaper does to a stalled worker).
        // Parked an hour out so nothing re-claims it during the test.
        await pool.query(
            `UPDATE jobs SET status = 'RETRY_SCHEDULED', locked_by = NULL, lease_expires_at = NULL,
                 run_at = now() + interval '1 hour' WHERE id = $1`,
            [id]
        );

        await waitFor(() => /Lost lease on job/.test(w.logs), { label: 'worker to notice lost lease' });
        await sleep(4500); // well past when the handler's effect would have fired
        expect(effectCount(log)).toBe(0);
        expect((await getJob(id)).status).toBe('RETRY_SCHEDULED'); // worker did not touch it
    }, 60000);
});
