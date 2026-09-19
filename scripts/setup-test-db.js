// Creates the taskflow_test database (if missing) and migrates it. Tests must
// never touch the dev database: they wipe tables. Run via `npm run test:db:setup`.
require('dotenv').config();
const { Client } = require('pg');
const { spawnSync } = require('child_process');

async function main() {
    const testUrl = process.env.TEST_DATABASE_URL;
    if (!testUrl) throw new Error('TEST_DATABASE_URL is not set (see .env.example)');
    const url = new URL(testUrl);
    const dbName = decodeURIComponent(url.pathname.slice(1));
    if (!dbName.endsWith('_test')) throw new Error(`Refusing: test database name must end in _test, got "${dbName}"`);

    const admin = new URL(testUrl);
    admin.pathname = '/postgres';
    const client = new Client({ connectionString: admin.toString() });
    await client.connect();
    try {
        const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
        if (rows.length === 0) {
            // Identifier can't be parameterized; the name is validated above and quoted here.
            await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
            console.log(`Created database ${dbName}`);
        }
    } finally {
        await client.end();
    }

    const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const res = spawnSync(cmd, ['node-pg-migrate', 'up', '--no-single-transaction'], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: { ...process.env, DATABASE_URL: testUrl },
    });
    process.exit(res.status ?? 1);
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
