import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';

/**
 * Context of the HTTP request being handled (like MDC in Java logging).
 * Everything that runs on behalf of a request, including the storage engine,
 * logs with its requestId.
 * @type {AsyncLocalStorage<{ requestId: string }>}
 */
export const requestContext = new AsyncLocalStorage();

/**
 * Creates the application logger: JSON lines, with the current request context
 * added to every entry.
 * @param {object} [options]
 * @param {string} [options.level] Default: LOG_LEVEL or "info"
 * @param {import('node:stream').Writable} [options.destination] Default: stdout
 */
export function createLogger({
    level = process.env.LOG_LEVEL ?? 'info',
    destination,
} = {}) {
    return pino(
        {
            level,
            // a copy: pino merges every entry's fields into the object returned here
            mixin: () => ({ ...requestContext.getStore() }),
            redact: ['req.headers.authorization', 'req.headers.cookie'],
        },
        destination
    );
}

/**
 * Application logger on stdout. For readable output in development pipe it
 * through pino-pretty (npm run dev does that).
 */
export const logger = createLogger();
