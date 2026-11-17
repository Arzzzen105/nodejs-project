import path from 'node:path';
import { createApp } from '../../src/app.js';
import { createLogger, currentRequest } from '../../src/logger.js';
import { FileDatabase } from '../../src/storage/file-database.js';
import { copySchema } from '../../scripts/copy-schema.js';
import { createTempDir, removeDir } from './temp-db.js';

const SCHEMA = path.resolve(import.meta.dirname, '..', '..', 'database');

/**
 * The whole application over a temporary database with the real schema, for
 * tests that send HTTP requests with supertest.
 * @returns {Promise<{ app: import('express').Express, container: object, root: string, close: () => Promise<void> }>}
 * @example
 * const { app, close } = await createTestApp();
 * await request(app).get('/api/kids').expect(200);
 * await close();
 */
export async function createTestApp() {
    const root = await createTempDir();
    await copySchema(SCHEMA, root);
    // as in server.js: changes are recorded with the request that made them
    const database = await new FileDatabase(root, {
        changeContext: currentRequest,
    }).init();
    const app = createApp(database, {
        logger: createLogger({ level: 'silent' }),
    });
    return {
        app,
        container: app.locals.container,
        root,
        close: async () => {
            await database.close();
            await removeDir(root);
        },
    };
}
