// Thrown by a handler (or the dispatcher) to distinguish "try again later"
// from "this will never succeed" - see docs/DESIGN.md.
class RetryableError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'RetryableError';
        this.retryable = true;
    }
}

// Unknown job type, schema-invalid payload, or any error a handler knows is
// deterministic - retrying would just waste attempts. Goes straight to DEAD.
class NonRetryableError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'NonRetryableError';
        this.retryable = false;
    }
}

module.exports = { RetryableError, NonRetryableError };
