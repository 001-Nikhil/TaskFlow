/**
 * Baseline migration: reproduces the schema that existed in init.sql before
 * any migration tool was introduced (see docs/AUDIT.md). Nothing here is
 * "correct" per CLAUDE.md Section 3 yet - the next migration
 * (add-reliability-and-state-machine) fixes it. This one exists so the
 * schema's history is in version control instead of a first-run-only SQL
 * file.
 */

exports.up = (pgm) => {
    pgm.createType('job_status', ['PENDING', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD']);

    pgm.createTable('jobs', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        type: { type: 'varchar(255)', notNull: true },
        payload: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
        status: { type: 'job_status', notNull: true, default: 'PENDING' },
        max_retries: { type: 'integer', notNull: true, default: 3 },
        retry_count: { type: 'integer', notNull: true, default: 0 },
        error_message: { type: 'text' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        processed_at: { type: 'timestamptz' },
    });

    pgm.createIndex('jobs', 'status', { name: 'idx_jobs_status' });
};

exports.down = (pgm) => {
    pgm.dropTable('jobs');
    pgm.dropType('job_status');
};
