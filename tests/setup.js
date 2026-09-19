import { beforeAll } from 'vitest';

beforeAll(() => {
    const url = process.env.DATABASE_URL || '';
    let dbName = '';
    try {
        dbName = decodeURIComponent(new URL(url).pathname.slice(1));
    } catch {
        // fall through to the error below
    }
    if (!dbName.endsWith('_test')) {
        throw new Error(
            `Refusing to run tests against database "${dbName}". Set TEST_DATABASE_URL to a *_test database and run: npm run test:db:setup`
        );
    }
});
