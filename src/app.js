import { randomUUID } from 'node:crypto';
import express from 'express';
import { StatusCodes } from 'http-status-codes';
import { pinoHttp } from 'pino-http';
import { createContainer } from './container.js';
import { createKidRouter } from './routes/kid-routes.js';
import { createResourceRouter } from './routes/resources.js';
import { logger, requestContext } from './logger.js';

// A request id sent by a proxy is reused only if it looks like an id.
const REQUEST_ID = /^[\w-]{1,100}$/;

// Errors of express.json() have a status and a "type", but no code.
const BODY_ERROR_CODES = {
    'entity.parse.failed': 'INVALID_JSON',
    'entity.too.large': 'PAYLOAD_TOO_LARGE',
};

/**
 * @param {Error & { code?: string, type?: string }} error
 * @param {number} status The status the error is answered with
 * @returns {string} Machine-readable code for the response
 */
function errorCode(error, status) {
    if (error.code) return error.code;
    if (BODY_ERROR_CODES[error.type]) return BODY_ERROR_CODES[error.type];
    return status >= StatusCodes.INTERNAL_SERVER_ERROR
        ? 'INTERNAL_ERROR'
        : 'BAD_REQUEST';
}

/**
 * Builds the HTTP application over a database. Opening and closing the database
 * is left to the caller: the server in production, a test over a temporary one.
 * @param {import('./storage/file-database.js').FileDatabase} database
 * @param {object} [options]
 * @param {import('pino').Logger} [options.logger] Default: the application logger
 * @returns {import('express').Express}
 */
export function createApp(database, { logger: appLogger = logger } = {}) {
    const app = express();
    const container = createContainer(database);

    app.disable('x-powered-by');
    app.locals.database = database;
    app.locals.container = container;

    app.use((req, res, next) => {
        const header = req.get('x-request-id');
        const requestId = REQUEST_ID.test(header ?? '') ? header : randomUUID();
        res.setHeader('x-request-id', requestId);
        requestContext.run({ requestId }, next);
    });

    app.use(
        pinoHttp({
            logger: appLogger,
            genReqId: (req, res) => res.getHeader('x-request-id'),
            customLogLevel: (req, res, error) => {
                if (
                    error ||
                    res.statusCode >= StatusCodes.INTERNAL_SERVER_ERROR
                ) {
                    return 'error';
                }
                if (res.statusCode >= StatusCodes.BAD_REQUEST) return 'warn';
                return 'info';
            },
            // Only the path: query strings (e.g. ?where={"lastName":...}) and headers
            // may contain personal data.
            serializers: {
                req: (req) => ({
                    method: req.method,
                    path: req.url.split('?')[0],
                }),
                res: (res) => ({ statusCode: res.statusCode }),
            },
        })
    );

    app.use(express.json({ limit: '1mb' }));

    app.get('/health', (req, res) => {
        res.status(StatusCodes.OK).json({ status: 'ok' });
    });

    app.use('/api/kids', createKidRouter(container.controllers.kids));

    // goes straight to the database, past the business rules of the services
    if (process.env.NODE_ENV !== 'production') {
        app.use('/api/test', createResourceRouter(database));
    }

    app.use((req, res) => {
        res.status(StatusCodes.NOT_FOUND).json({
            error: { code: 'NOT_FOUND', message: 'Route not found.' },
        });
    });

    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const status = Number.isInteger(error.status)
            ? error.status
            : StatusCodes.INTERNAL_SERVER_ERROR;
        if (status >= StatusCodes.INTERNAL_SERVER_ERROR)
            req.log.error({ err: error }, 'Request failed');
        res.status(status).json({
            error: {
                code: errorCode(error, status),
                message:
                    status >= StatusCodes.INTERNAL_SERVER_ERROR
                        ? 'An internal server error occurred.'
                        : error.message,
                ...(error.details && { details: error.details }),
            },
        });
    });

    return app;
}
