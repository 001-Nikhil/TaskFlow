// Handlers may run more than once for the same job (at-least-once delivery -
// see docs/DESIGN.md) and must be safe to re-run. `ctx.once(key, fn)` lets a
// handler mark a specific side effect as "already done" so a redelivery
// (e.g. after a lost ack) skips repeating it instead of, say, sending a
// duplicate email.
const handlers = {
    send_email: async (payload, ctx) => {
        await ctx.once('send', async () => {
            console.log(`[Task] Sending email to ${payload.to}...`);
            await ctx.sleep(500);
            console.log(`[Task] Email sent to ${payload.to}`);
        });
    },
    process_image: async (payload, ctx) => {
        console.log(`[Task] Resizing image at ${payload.imageUrl}...`);
        await ctx.sleep(500);
        console.log('[Task] Image resized.');
    },
};

// Chaos-test handler, registered only when TASKFLOW_ENABLE_TEST_HANDLERS=1 so
// it can never be submitted to a production API. It sleeps, applies one
// "external" side effect (an appended line in payload.logFile, guarded by
// ctx.once), then sleeps again - giving tests a window before and after the
// effect in which to kill the worker. The log file is the ground truth for
// "how many times did the side effect really happen".
if (process.env.TASKFLOW_ENABLE_TEST_HANDLERS === '1') {
    const fs = require('fs');
    handlers.chaos_effect = async (payload, ctx) => {
        await ctx.sleep(payload.beforeMs || 0);
        await ctx.once('effect', async () => {
            fs.appendFileSync(payload.logFile, `${ctx.jobId} attempt=${ctx.attempt}\n`);
        });
        await ctx.sleep(payload.afterMs || 0);
    };
}

const KNOWN_JOB_TYPES = Object.keys(handlers);

module.exports = { handlers, KNOWN_JOB_TYPES };
