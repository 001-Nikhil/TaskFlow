require('dotenv').config();

function required(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`);
    }
    return value;
}

// Getters, not eager reads: each process only demands the variables it
// actually uses. The worker needs DATABASE_URL and nothing else - it must not
// refuse to start (or be handed a secret) just because API_KEY is unset.
module.exports = {
    get databaseUrl() {
        return required('DATABASE_URL');
    },
    get redisUrl() {
        return required('REDIS_URL');
    },
    get port() {
        return parseInt(process.env.PORT || '3000', 10);
    },
    get apiKey() {
        return required('API_KEY');
    },
};
