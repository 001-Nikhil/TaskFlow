// Exponential backoff with full jitter (AWS "Exponential Backoff And Jitter"
// article). `random` is injected so tests can be deterministic.
//
// attempt: the attempt number that just failed (1 = first attempt failed).
// Returns the delay in ms to wait before the NEXT attempt.
function computeBackoffMs({ attempt, baseMs, maxMs, random = Math.random }) {
    if (attempt < 1) {
        throw new Error('attempt must be >= 1');
    }
    const cappedExponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
    return Math.floor(random() * cappedExponential);
}

module.exports = { computeBackoffMs };
