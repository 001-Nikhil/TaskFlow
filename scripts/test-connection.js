const {Pool} = require('pg');
const Redis = require('ioredis');

// configuring postgres connection
const pgPool = new Pool ({
    connectionString:
    process.env.DATABASE_URL || 'postgres://taskflow_user:taskflow_password@localhost:5432/taskflow_db',

});

//configuring redis connection
const redis = new Redis (
    process.env.REDIS_URL || 'redis://localhost:6379'
);

async function testConnections() {
    console.log('Testing Infra connections')

    try {
        const pgRes = await pgPool.query('SELECT NOW()');
        console.log('Postgress connected, Time : ', pgRes.rows[0].now);

        const redisRes = await redis.ping();
        console.log('Redis connected, ping : ', redisRes);
    }
    catch (err) {
        console.error ('connection error', err);
    }
    finally {
        await pgPool.end();
        redis.disconnect();
    }
}

//call bhi toh krna hai function ko
testConnections();