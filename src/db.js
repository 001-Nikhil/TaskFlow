const {Pool} = require('pg');

const pool = new Pool ({
    connectionString:
    process.env.DATABASE_URL || 'postgres://taskflow_user:taskflow_password@localhost:5432/taskflow_db',
    max: 10,
});

module.exports = pool;