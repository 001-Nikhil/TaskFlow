/**
 * Split out from add-reliability-and-state-machine: this partial index's
 * predicate references the RETRY_SCHEDULED enum value added in that
 * migration, and Postgres refuses to reference a new enum value inside the
 * same transaction that added it ("unsafe use of new value").
 */

exports.up = (pgm) => {
    // Claim query filters WHERE status IN ('QUEUED','RETRY_SCHEDULED') AND
    // run_at <= now(), ordered by priority then age - this partial index
    // covers exactly that predicate and sort order.
    pgm.createIndex('jobs', ['priority_rank', 'run_at', 'created_at'], {
        name: 'idx_jobs_claimable',
        where: "status IN ('QUEUED', 'RETRY_SCHEDULED')",
    });
};

exports.down = (pgm) => {
    pgm.dropIndex('jobs', ['priority_rank', 'run_at', 'created_at'], { name: 'idx_jobs_claimable' });
};
