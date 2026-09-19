// Fails fast and loudly instead of the Node default (a silent crash with no
// context, or - for an unhandled EventEmitter 'error' - an uncaught throw).
function installProcessGuards() {
    process.on('unhandledRejection', (reason) => {
        console.error('Unhandled promise rejection, exiting:', reason);
        process.exit(1);
    });

    process.on('uncaughtException', (err) => {
        console.error('Uncaught exception, exiting:', err);
        process.exit(1);
    });
}

module.exports = { installProcessGuards };
