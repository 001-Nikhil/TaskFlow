// SIGTERM chaos: the worker runs in a real container so `docker stop` sends
// a genuine, catchable SIGTERM (Windows cannot deliver one to a host process).
// Needs: `docker build -t taskflow:local .` and the compose stack running.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { pool, resetDb, insertJob, getJob, events, waitFor } from './helpers.js';

const NAME = 'taskflow_chaos_worker';
const NETWORK = process.env.COMPOSE_NETWORK || 'task_flow_claude_default';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

function startWorkerContainer(extraEnv = {}) {
    const env = {
        DATABASE_URL: `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@postgres:5432/${process.env.POSTGRES_DB}`,
        REDIS_URL: 'redis://redis:6379',
        API_KEY: process.env.API_KEY,
        TASKFLOW_ENABLE_TEST_HANDLERS: '1',
        WORKER_CONCURRENCY: '1',
        POLL_INTERVAL_MS: '100',
        REAP_INTERVAL_MS: '500',
        ...extraEnv,
    };
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    docker('run', '-d', '--name', NAME, '--network', NETWORK, ...envArgs, 'taskflow:local', 'node', 'src/worker.js');
}

function cleanup() {
    try {
        docker('rm', '-f', NAME);
    } catch {
        /* not running */
    }
}

// The container runs code baked into the image, so rebuild (cached, fast when
// nothing changed) to make sure we test the current source.
beforeAll(() => {
    docker('build', '-t', 'taskflow:local', '.');
}, 300000);

beforeEach(async () => {
    cleanup();
    await resetDb();
});
afterAll(async () => {
    cleanup();
    await pool.end();
});

// The container cannot see the host's tmp file, so the effect is asserted
// through the effects ledger table instead of a log file.
describe('chaos: SIGTERM mid-job', () => {
    it('finishes the in-flight job within the grace period, exits 0, deregisters', async () => {
        const id = await insertJob({ payload: { logFile: '/tmp/x.log', beforeMs: 3000, afterMs: 0 } });
        startWorkerContainer({ SHUTDOWN_GRACE_MS: '15000' });
        await waitFor(async () => (await getJob(id)).status === 'PROCESSING', { label: 'claim' });

        docker('stop', '-t', '30', NAME); // SIGTERM, then SIGKILL only after 30s
        const exitCode = docker('inspect', NAME, '--format', '{{.State.ExitCode}}');
        const logs = docker('logs', NAME);
        console.log('worker logs:\n' + logs);

        expect(exitCode).toBe('0');
        const job = await getJob(id);
        expect(job.status).toBe('COMPLETED');
        expect(job.attempt).toBe(1); // finished on its own attempt: no redelivery needed
        const { rows } = await pool.query("SELECT status FROM workers WHERE status <> 'ACTIVE'");
        expect(rows.map((r) => r.status)).toEqual(['STOPPED']);
    }, 60000);

    it('grace period too short: job is released for retry immediately (reason=shutdown), not left to lease expiry', async () => {
        const id = await insertJob({ payload: { logFile: '/tmp/x.log', beforeMs: 20000, afterMs: 0 } });
        startWorkerContainer({ SHUTDOWN_GRACE_MS: '1000', LEASE_MS: '60000' });
        await waitFor(async () => (await getJob(id)).status === 'PROCESSING', { label: 'claim' });

        docker('stop', '-t', '30', NAME);
        expect(docker('inspect', NAME, '--format', '{{.State.ExitCode}}')).toBe('0');

        const job = await getJob(id);
        // Lease is 60s, so if this were left to lease expiry the job would
        // still be PROCESSING here.
        expect(job.status).toBe('RETRY_SCHEDULED');
        expect(job.locked_by).toBeNull();
        const trail = await events(id);
        expect(trail[trail.length - 1].reason).toMatch(/shutdown/);
    }, 60000);
});
