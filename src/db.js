const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
    connectionString: config.databaseUrl,
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
    // Fail a connection attempt / stuck idle connection instead of hanging forever.
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
});

// pg emits 'error' on the pool when an IDLE client hits a connection-level
// error (e.g. the DB restarts). Without a listener, Node treats an unhandled
// EventEmitter 'error' event as an uncaught exception and kills the process.
pool.on('error', (err) => {
    console.error('Unexpected error on idle Postgres client:', err.message);
});

// The pool listener above does NOT cover a client that is currently checked
// out (e.g. between two statements of a transaction): if Postgres drops that
// connection, the client itself emits 'error', and with no listener on the
// client the process dies with an uncaught exception. Attach one to every
// client; the in-flight query (if any) rejects separately and is handled by
// the caller, so this only has to stop the crash.
pool.on('connect', (client) => {
    client.on('error', (err) => {
        console.error('Postgres client error (connection lost):', err.message);
    });
});

module.exports = pool;
