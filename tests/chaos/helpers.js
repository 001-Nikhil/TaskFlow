// Shared helpers for chaos tests. These run against the live docker-compose
// Postgres (DATABASE_URL from .env) and spawn REAL worker processes, because
// the point is to kill real processes, not mocks.
const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pool = require('../../src/db');

const ROOT = path.resolve(__dirname, '../..');

function spawnWorker(env = {}) {
    const child = spawn(process.execPath, ['src/worker.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            TASKFLOW_ENABLE_TEST_HANDLERS: '1',
            WORKER_CONCURRENCY: '2',
            POLL_INTERVAL_MS: '100',
            REAP_INTERVAL_MS: '500',
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.logs = '';
    child.stdout.on('data', (d) => (child.logs += d));
    child.stderr.on('data', (d) => (child.logs += d));
    child.exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    return child;
}

// Force-terminate: no signal handlers run, no cleanup - equivalent to kill -9.
function hardKill(child) {
    if (process.platform === 'win32') {
        execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
    } else {
        child.kill('SIGKILL');
    }
}

async function resetDb() {
    await pool.query('DELETE FROM effects');
    await pool.query('DELETE FROM job_events');
    await pool.query('UPDATE workers SET current_job_id = NULL');
    await pool.query('DELETE FROM jobs');
    await pool.query('DELETE FROM workers');
}

async function insertJob({ type = 'chaos_effect', payload = {}, maxAttempts = 4, timeoutMs = 30000 }) {
    const { rows } = await pool.query(
        `INSERT INTO jobs (type, payload, status, max_attempts, timeout_ms, backoff_base_ms, backoff_max_ms)
         VALUES ($1, $2, 'QUEUED', $3, $4, 100, 200) RETURNING id`,
        [type, payload, maxAttempts, timeoutMs]
    );
    return rows[0].id;
}

async function getJob(id) {
    const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows[0];
}

async function events(id) {
    const { rows } = await pool.query(
        'SELECT from_status, to_status, attempt, worker_id, reason FROM job_events WHERE job_id = $1 ORDER BY id',
        [id]
    );
    return rows;
}

async function waitFor(fn, { timeoutMs = 30000, intervalMs = 100, label = 'condition' } = {}) {
    const start = Date.now();
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

function tmpLog() {
    const f = path.join(os.tmpdir(), `taskflow-chaos-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    fs.writeFileSync(f, '');
    return f;
}

function effectCount(file) {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

module.exports = { pool, spawnWorker, hardKill, resetDb, insertJob, getJob, events, waitFor, tmpLog, effectCount };
