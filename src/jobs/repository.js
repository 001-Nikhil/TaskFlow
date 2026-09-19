const { computeBackoffMs } = require('./backoff');

// All job-state transitions live here so there is exactly one place that
// writes `jobs.status`, and every transition is paired with a job_events
// row. Every UPDATE is guarded by `WHERE status = ... AND locked_by = ...
// AND attempt = ...` (the fencing token) so a worker whose lease already
// expired - and who might still be running the old handler - cannot
// clobber whatever happened to the job since (CLAUDE.md Section 3.4).

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
// job) cannot resurrect its hold on it.
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

// Handles a handler failure: reads the job's own retry policy under
// FOR UPDATE (still fencing-guarded), then either schedules a backoff
// retry or moves the job straight to DEAD (non-retryable error, or
// attempts exhausted).
async function failJob(pool, { jobId, workerId, attempt, error, retryable, random }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const current = await client.query(
            `SELECT max_attempts, backoff_base_ms, backoff_max_ms
             FROM jobs
             WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt = $3
             FOR UPDATE`,
            [jobId, workerId, attempt]
        );

        if (current.rows.length === 0) {
            await client.query('ROLLBACK');
            return { fenced: true };
        }

        const { max_attempts: maxAttempts, backoff_base_ms: baseMs, backoff_max_ms: maxMs } = current.rows[0];
        const errorMessage = String(error && error.message ? error.message : error).slice(0, 2000);
        const exhausted = attempt >= maxAttempts;

        if (!retryable || exhausted) {
            const result = await client.query(
                `UPDATE jobs
                 SET status = 'DEAD', last_error = $4, updated_at = now(),
                     locked_by = NULL, lease_expires_at = NULL
                 WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt = $3
                 RETURNING *`,
                [jobId, workerId, attempt, errorMessage]
            );
            await recordEvent(client, {
                jobId,
                fromStatus: 'PROCESSING',
                toStatus: 'DEAD',
                workerId,
                attempt,
                reason: exhausted ? 'attempts_exhausted' : 'non_retryable_error',
            });
            await client.query('COMMIT');
            return { fenced: false, job: result.rows[0], deadLettered: true };
        }

        const delayMs = computeBackoffMs({ attempt, baseMs, maxMs, random });
        const result = await client.query(
            `UPDATE jobs
             SET status = 'RETRY_SCHEDULED', run_at = now() + make_interval(secs => $4::float / 1000),
                 last_error = $5, updated_at = now(), locked_by = NULL, lease_expires_at = NULL
             WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt = $3
             RETURNING *`,
            [jobId, workerId, attempt, delayMs / 1000, errorMessage]
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
// PROCESSING until the lease expires (which could be a full LEASE_MS of
// dead time). Fencing-guarded like every other transition. It never
// dead-letters: being interrupted by a deploy is not the job's fault. Note
// the claim already consumed an attempt number; that cannot be handed back
// because attempt is the fencing token and must never decrease.
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

// Reaper: reclaims PROCESSING jobs whose lease expired (worker crashed,
// was killed, or paused past its lease) by routing them through the same
// retry-or-dead decision as a normal failure. Uses database time
// (lease_expires_at < now()) exclusively - never a worker's clock.
async function reapExpiredLeases(pool, { random } = {}) {
    const client = await pool.connect();
    let expired;
    try {
        const result = await client.query(
            `SELECT id, locked_by, attempt
             FROM jobs
             WHERE status = 'PROCESSING' AND lease_expires_at < now()
             FOR UPDATE SKIP LOCKED
             LIMIT 100`
        );
        expired = result.rows;
    } finally {
        client.release();
    }

    const reaped = [];
    for (const row of expired) {
        const outcome = await failJob(pool, {
            jobId: row.id,
            workerId: row.locked_by,
            attempt: row.attempt,
            error: new Error('lease expired: worker did not complete or heartbeat in time'),
            retryable: true,
            random,
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
    reapExpiredLeases,
    recordEvent,
};
