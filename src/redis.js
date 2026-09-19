const Redis = require ('ioredis');

const redis = new Redis (
    process.env.REDIS_URL || 'redis://localhost:6379'
);

// Without a listener, an unhandled EventEmitter 'error' event throws and
// kills the process; ioredis retries connections on its own, so just log.
redis.on('error', (err) => {
    console.error('Redis client error:', err);
});

module.exports = redis;