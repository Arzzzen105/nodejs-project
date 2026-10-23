import app from './app.js';

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
}

await app.locals.database.init();

const server = app.listen(port, '0.0.0.0', () => {
    console.log(`HTTP server is listening on port ${port}.`);
});

let shuttingDown = false;

function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal}: stopping HTTP server.`);

    const timeout = setTimeout(() => {
        console.error('Shutdown timed out.');
        process.exit(1);
    }, 10000);
    timeout.unref();

    server.close(async () => {
        console.log('HTTP server stopped successfully.');
        try {
            // finishes the running transaction and releases the database directory
            await app.locals.database.close();
            console.log('Database closed.');
        } catch (error) {
            console.error('Database could not be closed cleanly.');
            console.error(error);
            process.exitCode = 1;
        } finally {
            clearTimeout(timeout);
        }
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.on('error', (error) => {
    console.error(
        'HTTP server could not start. Check whether its port is in use.'
    );
    console.error(error.message);
    process.exitCode = 1;
    shutdown('Server error');
});
