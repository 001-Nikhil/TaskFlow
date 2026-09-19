const Redis = require('ioredis');
const config = require('./config');

const redis = new Redis(config.redisUrl);

// Without a listener, an unhandled EventEmitter 'error' event throws and
// kills the process; ioredis retries connections on its own, so just log.
redis.on('error', (err) => {
    console.error('Redis client error:', err);
});

module.exports = redis;
