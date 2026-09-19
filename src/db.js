const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
});

// pg emits 'error' on the pool when an idle client hits a connection-level
// error (e.g. the DB restarts). Without a listener, Node treats an unhandled
// EventEmitter 'error' event as an uncaught exception and kills the process.
pool.on('error', (err) => {
    console.error('Unexpected error on idle Postgres client:', err);
});

module.exports = pool;
