// Execution idempotency (CLAUDE.md Section 3.6.2). At-least-once delivery
// means a handler can run more than once for the same job (e.g. it
// succeeded but the worker crashed before the COMPLETED write landed, so
// the reaper redelivers it - the "lost ack" scenario). `once()` claims an
// effect key before running it: a redelivery that finds the key already
// claimed skips the side effect entirely instead of repeating it.
//
// This is a "claim, then act" pattern, not a distributed transaction: for
// a true external effect (an email API call) there's no way to make the
// claim and the external call atomic. If the process dies mid-call, the
// claim survives and a redelivery will skip retrying it - we accept a
// possible missed send over a duplicate one. If `fn` throws, the claim is
// released so a genuine retry can attempt the effect again.
async function once(pool, jobId, effectKey, fn) {
    const claim = await pool.query(
        `INSERT INTO effects (job_id, effect_key) VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING job_id`,
        [jobId, effectKey]
    );

    if (claim.rows.length === 0) {
        return { alreadyRan: true, result: undefined };
    }

    try {
        const result = await fn();
        return { alreadyRan: false, result };
    } catch (err) {
        await pool.query('DELETE FROM effects WHERE job_id = $1 AND effect_key = $2', [jobId, effectKey]);
        throw err;
    }
}

module.exports = { once };
