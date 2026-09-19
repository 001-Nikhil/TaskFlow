// Every test suite runs against TEST_DATABASE_URL, never the dev DATABASE_URL:
// the suites wipe jobs/effects/workers. tests/setup.js enforces the `_test`
// suffix so a misconfigured URL fails loudly instead of deleting dev data.
require('dotenv').config();
const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
    test: {
        env: { DATABASE_URL: process.env.TEST_DATABASE_URL || '' },
        setupFiles: ['./tests/setup.js'],
    },
});
