// Container healthcheck for a worker: healthy only if this container's worker
// registered in Postgres and its heartbeat is recent. Uses the database clock
// (now()), like every other liveness decision in the system.
const os = require('os');
const pool = require('./db');

const MAX_AGE_MS = parseInt(process.env.HEALTHCHECK_MAX_AGE_MS || '45000', 10);

async function main() {
    const { rows } = await pool.query(
        `SELECT 1 FROM workers
         WHERE hostname = $1 AND status = 'ACTIVE'
           AND last_heartbeat_at > now() - make_interval(secs => $2::float / 1000)
         LIMIT 1`,
        [os.hostname(), MAX_AGE_MS]
    );
    await pool.end();
    process.exit(rows.length > 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('worker healthcheck failed:', err.message);
    process.exit(1);
});
