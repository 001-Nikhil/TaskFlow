// Worker liveness (CLAUDE.md Section 3.11). Separate from a job's lease:
// this heartbeat says "this worker process is alive", the job lease says
// "this specific job is being worked". The reaper only needs job leases to
// recover stuck jobs; this table is what a dashboard/operator uses to see
// which workers are up and what they're doing right now.

async function registerWorker(pool, { id, hostname, pid, version }) {
    await pool.query(
        `INSERT INTO workers (id, hostname, pid, version, status, started_at, last_heartbeat_at)
         VALUES ($1, $2, $3, $4, 'ACTIVE', now(), now())
         ON CONFLICT (id) DO UPDATE
             SET hostname = EXCLUDED.hostname, pid = EXCLUDED.pid, version = EXCLUDED.version,
                 status = 'ACTIVE', started_at = now(), last_heartbeat_at = now()`,
        [id, hostname || null, pid || null, version || null]
    );
}

async function heartbeatWorker(pool, { id, currentJobId }) {
    await pool.query(
        `UPDATE workers SET last_heartbeat_at = now(), current_job_id = $2, status = 'ACTIVE' WHERE id = $1`,
        [id, currentJobId || null]
    );
}

async function deregisterWorker(pool, { id }) {
    await pool.query(
        `UPDATE workers SET status = 'STOPPED', current_job_id = NULL WHERE id = $1`,
        [id]
    );
}

// Marks workers dead if they haven't heartbeat within `thresholdMs`. This
// alone does not recover their jobs - the lease reaper (repository.js) does
// that independently once lease_expires_at passes, which is what actually
// matters for correctness. This just keeps the registry honest for
// dashboards/metrics.
async function markDeadWorkers(pool, { thresholdMs }) {
    const result = await pool.query(
        `UPDATE workers
         SET status = 'DEAD'
         WHERE status = 'ACTIVE' AND last_heartbeat_at < now() - make_interval(secs => $1::float / 1000)
         RETURNING id`,
        [thresholdMs]
    );
    return result.rows.map((r) => r.id);
}

module.exports = { registerWorker, heartbeatWorker, deregisterWorker, markDeadWorkers };
