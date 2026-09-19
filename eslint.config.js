const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
    { ignores: ['node_modules/', 'dist/', 'coverage/'] },
    js.configs.recommended,
    {
        languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: globals.node },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-empty': ['error', { allowEmptyCatch: false }],
            eqeqeq: ['error', 'always'],
        },
    },
    {
        // Tests are ES modules (vitest) mixed with CommonJS helpers.
        files: ['tests/**/*.js'],
        languageOptions: { sourceType: 'module', globals: { ...globals.node } },
    },
    {
        files: ['tests/chaos/helpers.js', 'vitest.config.js'],
        languageOptions: { sourceType: 'commonjs' },
    },
    prettier,
];
