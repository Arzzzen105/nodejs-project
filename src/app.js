import express from 'express';
import { FileDatabase } from './storage/file-database.js';
import { createResourceRouter } from './routes/resources.js';

const app = express();
const database = new FileDatabase();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.locals.database = database;

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

app.use('/api', createResourceRouter(database));

app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) console.error(error);
    res.status(status).json({
        error: {
            code: error.code ?? 'INTERNAL_ERROR',
            message: status >= 500 ? 'An internal server error occurred.' : error.message,
        },
    });
});

export default app;
