const { computeBackoffMs } = require('./backoff');

// All job-state transitions live here so there is exactly one place that
// writes `jobs.status`, and every transition is paired with a job_events
// row. Every UPDATE is guarded by `WHERE status = ... AND locked_by = ...
// AND attempt = ...` (the fencing token) so a worker whose lease already
// expired - and who might still be running the old handler - cannot
// clobber whatever happened to the job since (CLAUDE.md Section 3.4).
//
// Three counters, three jobs (see migration add-failure-and-recovery-counters):
//   attempt        fencing token, +1 on every claim
//   failure_count  handler failures; the only thing max_attempts limits
//   recovery_count lease-expiry recoveries; capped separately (poison jobs)

async function recordEvent(client, { jobId, fromStatus, toStatus, workerId, attempt, reason }) {
    await client.query(
        `INSERT INTO job_events (job_id, from_status, to_status, worker_id, attempt, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [jobId, fromStatus, toStatus, workerId || null, attempt ?? null, reason || null]
    );
}

// Atomically claims the next eligible job for this worker: picks the
// highest-priority, oldest, due (run_at <= now()) QUEUED/RETRY_SCHEDULED
// row with FOR UPDATE SKIP LOCKED (so N concurrent workers never pick the
// same row), then transitions it to PROCESSING with a fresh lease and a
// bumped `attempt` (attempt IS the fencing token: it must increase on every
// claim, not just on retries, so a stale worker's later UPDATE using the
// old attempt value always fails the guard).
async function claimNextJob(pool, { workerId, leaseMs }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `WITH candidate AS (
                 SELECT id, status AS old_status
                 FROM jobs
                 WHERE status IN ('QUEUED', 'RETRY_SCHEDULED') AND run_at <= now()
                 ORDER BY priority_rank ASC, run_at ASC, created_at ASC
                 FOR UPDATE SKIP LOCKED
                 LIMIT 1
             )
             UPDATE jobs
             SET status = 'PROCESSING',
                 locked_by = $1,
                 attempt = jobs.attempt + 1,
                 lease_expires_at = now() + make_interval(secs => $2::float / 1000),
                 started_at = now(),
                 updated_at = now()
             FROM candidate
             WHERE jobs.id = candidate.id
             RETURNING jobs.*, candidate.old_status`,
            [workerId, leaseMs]
        );

        if (result.rows.length === 0) {
            await client.query('COMMIT');
            return null;
        }

        const job = result.rows[0];
        await recordEvent(client, {
            jobId: job.id,
            fromStatus: job.old_status,
            toStatus: 'PROCESSING',
            workerId,
            attempt: job.attempt,
            reason: 'claimed',
        });
        await client.query('COMMIT');
        delete job.old_status;
        return job;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Extends the lease of a job this worker still holds (heartbeat). Guarded
// by attempt so a worker that lost its lease (reaper already reclaimed the
// job) cannot resurrect its hold on it. A `false` return means "you no
// longer own this job": the worker must stop working on it.
async function extendLease(pool, { jobId, workerId, attempt, leaseMs }) {
    const result = await pool.query(
        `UPDATE jobs
         SET lease_expires_at = now() + make_interval(secs => $4::float / 1000),
             updated_at = now()
         WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt = $3
         RETURNING id`,
        [jobId, workerId, attempt, leaseMs]
    );
    return result.rows.length > 0;
}

async function completeJob(pool, { jobId, workerId, attempt }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE jobs
             SET status = 'COMPLETED', completed_at = now(), updated_at = now(),
                 locked_by = NULL, lease_expires_at = NULL
             WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt = $3
             RETURNING *`,
            [jobId, workerId, attempt]
        );

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return { fenced: true };
        }

        await recordEvent(client, {
            jobId,
            fromStatus: 'PROCESSING',
            toStatus: 'COMPLETED',
            workerId,
            attempt,
            reason: 'completed',
        });
        await client.query('COMMIT');
        return { fenced: false, job: result.rows[0] };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Handles a HANDLER failure: reads the job's own retry policy under
// FOR UPDATE (still fencing-guarded), then either schedules a backoff retry
// or moves the job straight to DEAD (non-retryable error, or failure budget
// exhausted). failure_count - not attempt - is what max_attempts limits:
// attempt is the fencing token and also rises on crashes/shutdowns, which
// must not use up the job's retry budget.
async function failJob(pool, { jobId, workerId, attempt, error, retryable, random }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const current = await client.query(
            `SELECT max_attempts, failure_count, backoff_base_ms, backoff_max_ms
             FROM jobs
             WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt = $3
             FOR UPDATE`,
            [jobId, workerId, attempt]
        );

        if (current.rows.length === 0) {
            await client.query('ROLLBACK');
            return { fenced: true };
        }

        const row = current.rows[0];
        const failures = row.failure_count + 1;
        const errorMessage = String(error && error.message ? error.message : error).slice(0, 2000);
        const exhausted = failures >= row.max_attempts;

        if (!retryable || exhausted) {
            const result = await client.query(
                `UPDATE jobs
                 SET status = 'DEAD', last_error = $4, failure_count = $5, updated_at = now(),
                     locked_by = NULL, lease_expires_at = NULL
                 WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt = $3
                 RETURNING *`,
                [jobId, workerId, attempt, errorMessage, failures]
            );
            await recordEvent(client, {
                jobId,
                fromStatus: 'PROCESSING',
                toStatus: 'DEAD',
                workerId,
                attempt,
                reason: retryable ? 'attempts_exhausted' : 'non_retryable_error',
            });
            await client.query('COMMIT');
            return { fenced: false, job: result.rows[0], deadLettered: true };
        }

        const delayMs = computeBackoffMs({
            attempt: failures,
            baseMs: row.backoff_base_ms,
            maxMs: row.backoff_max_ms,
            random,
        });
        const result = await client.query(
            `UPDATE jobs
             SET status = 'RETRY_SCHEDULED', run_at = now() + make_interval(secs => $4::float / 1000),
                 last_error = $5, failure_count = $6, updated_at = now(), locked_by = NULL, lease_expires_at = NULL
             WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt = $3
             RETURNING *`,
            [jobId, workerId, attempt, delayMs, errorMessage, failures]
        );
        await recordEvent(client, {
            jobId,
            fromStatus: 'PROCESSING',
            toStatus: 'RETRY_SCHEDULED',
            workerId,
            attempt,
            reason: `retry_in_${delayMs}ms`,
        });
        await client.query('COMMIT');
        return { fenced: false, job: result.rows[0], deadLettered: false, delayMs };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Graceful-shutdown release (CLAUDE.md 3.12): hands a job this worker still
// holds straight back to the queue, due immediately, instead of leaving it
// PROCESSING until the lease expires. Fencing-guarded like every other
// transition. Touches neither failure_count nor recovery_count: being
// interrupted by a deploy is not the job's fault.
async function releaseJob(pool, { jobId, workerId, attempt, reason }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE jobs
             SET status = 'RETRY_SCHEDULED', run_at = now(), updated_at = now(),
                 locked_by = NULL, lease_expires_at = NULL
             WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt = $3
             RETURNING id`,
            [jobId, workerId, attempt]
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return { fenced: true };
        }
        await recordEvent(client, {
            jobId,
            fromStatus: 'PROCESSING',
            toStatus: 'RETRY_SCHEDULED',
            workerId,
            attempt,
            reason,
        });
        await client.query('COMMIT');
        return { fenced: false };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Lease-expiry recovery (used by the reaper). The worker did not fail - it
// vanished - so this does NOT touch failure_count: the job goes straight
// back to the queue, due now. recovery_count has its own cap so a job that
// kills every worker it touches is quarantined (DEAD) rather than looping
// forever. The guard re-checks lease_expires_at < now() *inside* the UPDATE:
// the reaper's earlier SELECT may be stale, and a worker heartbeat that
// extended the lease in between must win.
async function recoverJob(pool, { jobId, workerId, attempt, maxRecoveries }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const current = await client.query(
            `SELECT recovery_count
             FROM jobs
             WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt = $3
               AND lease_expires_at < now()
             FOR UPDATE`,
            [jobId, workerId, attempt]
        );
        if (current.rows.length === 0) {
            await client.query('ROLLBACK');
            return { fenced: true };
        }

        const recoveries = current.rows[0].recovery_count + 1;
        const quarantine = recoveries > maxRecoveries;
        const result = await client.query(
            `UPDATE jobs
             SET status = $2,
                 run_at = now(),
                 recovery_count = $3,
                 last_error = $4,
                 updated_at = now(),
                 locked_by = NULL,
                 lease_expires_at = NULL
             WHERE id = $1
             RETURNING *`,
            [
                jobId,
                quarantine ? 'DEAD' : 'RETRY_SCHEDULED',
                recoveries,
                quarantine
                    ? `poison job quarantined: lease expired ${recoveries} times (worker crash loop?)`
                    : 'lease expired: worker did not complete or heartbeat in time',
            ]
        );
        await recordEvent(client, {
            jobId,
            fromStatus: 'PROCESSING',
            toStatus: quarantine ? 'DEAD' : 'RETRY_SCHEDULED',
            workerId,
            attempt,
            reason: quarantine ? 'poison_quarantined' : 'lease_expired_recovered',
        });
        await client.query('COMMIT');
        return { fenced: false, job: result.rows[0], deadLettered: quarantine };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Reaper: finds PROCESSING jobs whose lease expired (worker crashed, was
// killed, or paused past its lease) and recovers each one. Uses database
// time (lease_expires_at < now()) exclusively - never a worker's clock. No
// row locks are needed on the scan: recoverJob's guarded UPDATE is what
// makes several concurrent reapers safe (only one can win each job).
async function reapExpiredLeases(pool, { maxRecoveries = 10 } = {}) {
    const { rows } = await pool.query(
        `SELECT id, locked_by, attempt
         FROM jobs
         WHERE status = 'PROCESSING' AND lease_expires_at < now()
         ORDER BY lease_expires_at
         LIMIT 100`
    );

    const reaped = [];
    for (const row of rows) {
        const outcome = await recoverJob(pool, {
            jobId: row.id,
            workerId: row.locked_by,
            attempt: row.attempt,
            maxRecoveries,
        });
        if (!outcome.fenced) {
            reaped.push({ jobId: row.id, deadLettered: outcome.deadLettered });
        }
    }
    return reaped;
}

module.exports = {
    claimNextJob,
    extendLease,
    completeJob,
    failJob,
    releaseJob,
    recoverJob,
    reapExpiredLeases,
    recordEvent,
};
