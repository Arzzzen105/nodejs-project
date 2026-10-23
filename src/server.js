import app from './app.js';
import { logger } from './logger.js';

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
}

try {
    await app.locals.database.init();
} catch (error) {
    logger.fatal({ err: error }, 'Database could not be opened');
    process.exit(1);
}

const server = app.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'HTTP server is listening');
});

let shuttingDown = false;

/**
 * Stops accepting connections, waits for running requests, then closes the
 * database. Exits with an error if this takes longer than 10 seconds.
 * @param {string} signal What triggered the shutdown, for the log
 */
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Stopping HTTP server');

    const timeout = setTimeout(() => {
        logger.error('Shutdown timed out');
        process.exit(1);
    }, 10000);
    timeout.unref();

    server.close(async () => {
        logger.info('HTTP server stopped');
        try {
            // finishes the running transaction and releases the database directory
            await app.locals.database.close();
        } catch (error) {
            logger.error(
                { err: error },
                'Database could not be closed cleanly'
            );
            process.exitCode = 1;
        } finally {
            clearTimeout(timeout);
        }
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.on('error', (error) => {
    logger.error(
        { err: error },
        'HTTP server could not start. Check whether its port is in use.'
    );
    process.exitCode = 1;
    shutdown('Server error');
});
