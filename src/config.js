require('dotenv').config();

function required(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`);
    }
    return value;
}

module.exports = {
    databaseUrl: required('DATABASE_URL'),
    redisUrl: required('REDIS_URL'),
    port: parseInt(process.env.PORT || '3000', 10),
};
