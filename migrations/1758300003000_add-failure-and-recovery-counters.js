/**
 * Separates the three things `attempt` used to conflate:
 *  - attempt         : fencing token, +1 on EVERY claim (unchanged).
 *  - failure_count   : handler failures. The ONLY counter compared with
 *                      max_attempts, so infrastructure events (worker crash,
 *                      lease expiry, deploy/shutdown) never burn a job's
 *                      retry budget.
 *  - recovery_count  : lease-expiry recoveries by the reaper. Has its own
 *                      cap so a job that crashes every worker that touches it
 *                      (a poison job) is eventually quarantined to DEAD
 *                      instead of crash-looping the fleet forever.
 * Also adds a CHECK that a PROCESSING row always carries a lease owner and
 * expiry (otherwise the reaper could never see it).
 */

exports.up = (pgm) => {
    pgm.addColumns('jobs', {
        failure_count: { type: 'integer', notNull: true, default: 0 },
        recovery_count: { type: 'integer', notNull: true, default: 0 },
    });
    pgm.addConstraint('jobs', 'jobs_failure_count_nonnegative', 'CHECK (failure_count >= 0)');
    pgm.addConstraint('jobs', 'jobs_recovery_count_nonnegative', 'CHECK (recovery_count >= 0)');
    // Conservative backfill: rows that already failed keep the budget they had consumed.
    pgm.sql("UPDATE jobs SET failure_count = attempt WHERE status IN ('RETRY_SCHEDULED', 'DEAD')");
    pgm.addConstraint(
        'jobs',
        'jobs_processing_has_lease',
        "CHECK (status <> 'PROCESSING' OR (locked_by IS NOT NULL AND lease_expires_at IS NOT NULL))"
    );
};

exports.down = (pgm) => {
    pgm.dropConstraint('jobs', 'jobs_processing_has_lease');
    pgm.dropConstraint('jobs', 'jobs_recovery_count_nonnegative');
    pgm.dropConstraint('jobs', 'jobs_failure_count_nonnegative');
    pgm.dropColumns('jobs', ['recovery_count', 'failure_count']);
};
