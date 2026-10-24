import { randomUUID } from 'node:crypto';
import express from 'express';
import { StatusCodes } from 'http-status-codes';
import { pinoHttp } from 'pino-http';
import { FileDatabase } from './storage/file-database.js';
import { createResourceRouter } from './routes/resources.js';
import { logger, requestContext } from './logger.js';

// A request id sent by a proxy is reused only if it looks like an id.
const REQUEST_ID = /^[\w-]{1,100}$/;

const app = express();
const database = new FileDatabase(undefined, {
    logger: logger.child({ module: 'storage' }),
});

app.disable('x-powered-by');
app.locals.database = database;

app.use((req, res, next) => {
    const header = req.get('x-request-id');
    const requestId = REQUEST_ID.test(header ?? '') ? header : randomUUID();
    res.setHeader('x-request-id', requestId);
    requestContext.run({ requestId }, next);
});

app.use(
    pinoHttp({
        logger,
        genReqId: (req, res) => res.getHeader('x-request-id'),
        customLogLevel: (req, res, error) => {
            if (error || res.statusCode >= StatusCodes.INTERNAL_SERVER_ERROR) {
                return 'error';
            }
            if (res.statusCode >= StatusCodes.BAD_REQUEST) return 'warn';
            return 'info';
        },
        // Only the path: query strings (e.g. ?where={"lastName":...}) and headers
        // may contain personal data.
        serializers: {
            req: (req) => ({ method: req.method, path: req.url.split('?')[0] }),
            res: (res) => ({ statusCode: res.statusCode }),
        },
    })
);

app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
    res.status(StatusCodes.OK).json({ status: 'ok' });
});

app.use('/api/test', createResourceRouter(database));

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
            code: error.code ?? 'INTERNAL_ERROR',
            message:
                status >= StatusCodes.INTERNAL_SERVER_ERROR
                    ? 'An internal server error occurred.'
                    : error.message,
        },
    });
});

export default app;
