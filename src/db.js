const {Pool} = require('pg');

const pool = new Pool ({
    connectionString:
    process.env.DATABASE_URL || 'postgres://taskflow_user:taskflow_password@localhost:5432/taskflow_db',
    max: 10,
});

// pg emits 'error' on the pool when an idle client hits a connection-level
// error (e.g. the DB restarts). Without a listener, Node treats an unhandled
// EventEmitter 'error' event as an uncaught exception and kills the process.
pool.on('error', (err) => {
    console.error('Unexpected error on idle Postgres client:', err);
});

module.exports = pool;