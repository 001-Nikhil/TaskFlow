/**
 * Implements CLAUDE.md Section 3 invariants on top of the baseline schema:
 * leases + fencing (locked_by/attempt/lease_expires_at), priority + delayed
 * jobs (priority_rank/run_at), configurable retry/backoff/timeout per job,
 * submission idempotency (unique idempotency_key), execution idempotency
 * (effects table), the job_events audit trail, and the workers registry
 * for heartbeat/dead-worker detection.
 *
 * Renames retry_count -> attempt (it doubles as the fencing token: it must
 * increase on every claim, not just every failure), max_retries ->
 * max_attempts (now counts total attempts, not retries-after-the-first),
 * error_message -> last_error, processed_at -> completed_at (it was being
 * set when processing *started*, which is the wrong name for that).
 *
 * FAILED is superseded by DEAD (the DLQ state) - see docs/AUDIT.md Section
 * 0.1. Existing FAILED rows are migrated to DEAD. The enum value FAILED
 * itself is left in place (Postgres cannot cheaply drop an enum value) but
 * the application no longer writes it; this is a deliberate simplification
 * documented in docs/DESIGN.md rather than a full type-rebuild, since no
 * production data exists yet to justify the extra risk.
 */

exports.up = (pgm) => {
    // New resting/terminal states. Not used within this same transaction,
    // so this is safe on Postgres 12+ (ADD VALUE cannot be used in the same
    // transaction that introduces it, but can always be added).
    pgm.sql("ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'SCHEDULED'");
    pgm.sql("ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'RETRY_SCHEDULED'");
    pgm.sql("ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'CANCELLED'");

    pgm.renameColumn('jobs', 'retry_count', 'attempt');
    pgm.renameColumn('jobs', 'max_retries', 'max_attempts');
    pgm.renameColumn('jobs', 'error_message', 'last_error');
    pgm.renameColumn('jobs', 'processed_at', 'completed_at');

    // Semantic shift: max_retries meant "retries allowed after the first
    // attempt" (3 -> 4 attempts total); max_attempts means total attempts.
    pgm.sql('UPDATE jobs SET max_attempts = max_attempts + 1');
    pgm.alterColumn('jobs', 'max_attempts', { default: 4 });

    pgm.sql("UPDATE jobs SET status = 'DEAD' WHERE status = 'FAILED'");

    pgm.addColumns('jobs', {
        priority_rank: { type: 'smallint', notNull: true, default: 2 },
        run_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        backoff_base_ms: { type: 'integer', notNull: true, default: 2000 },
        backoff_max_ms: { type: 'integer', notNull: true, default: 300000 },
        timeout_ms: { type: 'integer', notNull: true, default: 30000 },
        idempotency_key: { type: 'text' },
        locked_by: { type: 'text' },
        lease_expires_at: { type: 'timestamptz' },
        started_at: { type: 'timestamptz' },
    });

    pgm.addConstraint('jobs', 'jobs_attempt_nonnegative', 'CHECK (attempt >= 0)');
    pgm.addConstraint('jobs', 'jobs_max_attempts_positive', 'CHECK (max_attempts > 0)');
    pgm.addConstraint('jobs', 'jobs_priority_rank_valid', 'CHECK (priority_rank IN (1, 2, 3))');
    pgm.addConstraint('jobs', 'jobs_backoff_base_positive', 'CHECK (backoff_base_ms > 0)');
    pgm.addConstraint('jobs', 'jobs_backoff_max_gte_base', 'CHECK (backoff_max_ms >= backoff_base_ms)');
    pgm.addConstraint('jobs', 'jobs_timeout_positive', 'CHECK (timeout_ms > 0)');
    // Plain UNIQUE: Postgres treats every NULL as distinct, so jobs without
    // an idempotency key never collide with each other.
    pgm.addConstraint('jobs', 'jobs_idempotency_key_unique', 'UNIQUE (idempotency_key)');

    pgm.createTable('job_events', {
        id: { type: 'bigserial', primaryKey: true },
        job_id: {
            type: 'uuid',
            notNull: true,
            references: 'jobs',
            onDelete: 'CASCADE',
        },
        from_status: { type: 'job_status' },
        to_status: { type: 'job_status', notNull: true },
        at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        worker_id: { type: 'text' },
        attempt: { type: 'integer' },
        reason: { type: 'text' },
    });
    pgm.createIndex('job_events', ['job_id', 'at']);

    pgm.createTable('workers', {
        id: { type: 'text', primaryKey: true },
        hostname: { type: 'text' },
        pid: { type: 'integer' },
        started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        last_heartbeat_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        status: { type: 'text', notNull: true, default: 'ACTIVE' },
        current_job_id: {
            type: 'uuid',
            references: 'jobs',
            onDelete: 'SET NULL',
        },
        version: { type: 'text' },
    });

    // Execution-idempotency ledger: a handler calls ctx.once(effectKey, fn)
    // which inserts here in the same transaction as the side effect, so a
    // redelivered job can detect it already ran this effect.
    pgm.createTable('effects', {
        job_id: {
            type: 'uuid',
            notNull: true,
            references: 'jobs',
            onDelete: 'CASCADE',
        },
        effect_key: { type: 'text', notNull: true },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    }, {
        constraints: { primaryKey: ['job_id', 'effect_key'] },
    });

    // idx_jobs_claimable (on RETRY_SCHEDULED) is added in the next migration:
    // a partial index predicate referencing a brand-new enum value cannot be
    // created in the same transaction that adds the value ("unsafe use of
    // new value" - Postgres requires it to be committed first).

    // Reaper scans PROCESSING jobs whose lease expired.
    pgm.createIndex('jobs', ['lease_expires_at'], {
        name: 'idx_jobs_processing_lease',
        where: "status = 'PROCESSING'",
    });

    // Dashboard queries filter/group by status and sort/bucket by created_at;
    // this composite index also serves plain status lookups (leftmost
    // prefix), making the old single-column idx_jobs_status redundant.
    pgm.createIndex('jobs', ['status', 'created_at'], { name: 'idx_jobs_status_created' });
    pgm.sql('DROP INDEX IF EXISTS idx_jobs_status');
};

exports.down = (pgm) => {
    pgm.createIndex('jobs', 'status', { name: 'idx_jobs_status' });
    pgm.dropIndex('jobs', ['status', 'created_at'], { name: 'idx_jobs_status_created' });
    pgm.dropIndex('jobs', ['lease_expires_at'], { name: 'idx_jobs_processing_lease' });

    pgm.dropTable('effects');
    pgm.dropTable('workers');
    pgm.dropTable('job_events');

    pgm.dropConstraint('jobs', 'jobs_idempotency_key_unique');
    pgm.dropConstraint('jobs', 'jobs_timeout_positive');
    pgm.dropConstraint('jobs', 'jobs_backoff_max_gte_base');
    pgm.dropConstraint('jobs', 'jobs_backoff_base_positive');
    pgm.dropConstraint('jobs', 'jobs_priority_rank_valid');
    pgm.dropConstraint('jobs', 'jobs_max_attempts_positive');
    pgm.dropConstraint('jobs', 'jobs_attempt_nonnegative');

    pgm.dropColumns('jobs', [
        'started_at',
        'lease_expires_at',
        'locked_by',
        'idempotency_key',
        'timeout_ms',
        'backoff_max_ms',
        'backoff_base_ms',
        'run_at',
        'priority_rank',
    ]);

    pgm.sql("UPDATE jobs SET status = 'FAILED' WHERE status = 'DEAD'");
    pgm.sql('UPDATE jobs SET max_attempts = max_attempts - 1');

    pgm.renameColumn('jobs', 'completed_at', 'processed_at');
    pgm.renameColumn('jobs', 'last_error', 'error_message');
    pgm.renameColumn('jobs', 'max_attempts', 'max_retries');
    pgm.renameColumn('jobs', 'attempt', 'retry_count');

    // SCHEDULED/RETRY_SCHEDULED/CANCELLED enum labels are intentionally left
    // in place - Postgres cannot drop individual enum values without
    // rebuilding the type, and leaving unused labels is harmless.
};
