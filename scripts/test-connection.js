const pgPool = require('../src/db');
const redis = require('../src/redis');

async function testConnections() {
    console.log('Testing Infra connections');

    try {
        const pgRes = await pgPool.query('SELECT NOW()');
        console.log('Postgres connected, Time : ', pgRes.rows[0].now);

        const redisRes = await redis.ping();
        console.log('Redis connected, ping : ', redisRes);
    }
    catch (err) {
        console.error('connection error', err);
        process.exitCode = 1;
    }
    finally {
        await pgPool.end();
        redis.disconnect();
    }
}

testConnections();
