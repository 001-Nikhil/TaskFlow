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

const KNOWN_JOB_TYPES = Object.keys(handlers);

module.exports = { handlers, KNOWN_JOB_TYPES };
