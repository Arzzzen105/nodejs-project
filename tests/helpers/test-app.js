import path from 'node:path';
import { createApp } from '../../src/app.js';
import { createLogger, currentRequest } from '../../src/logger.js';
import { FileDatabase } from '../../src/storage/file-database.js';
import { copySchema } from '../../scripts/copy-schema.js';
import { createTempDir, removeDir } from './temp-db.js';

const SCHEMA = path.resolve(import.meta.dirname, '..', '..', 'database');

/** Signs the tokens of test applications. */
export const TEST_TOKEN_SECRET = 'test-secret';

/** Credentials of the admin every test application starts with. */
export const TEST_ADMIN = Object.freeze({
    username: 'admin',
    password: 'admin-password',
});

/**
 * Sends every request with a token, unless it has an Authorization header
 * of its own. supertest accepts a request handler as well as an application.
 * @param {import('express').Express} app
 * @param {string} token
 * @returns {import('express').RequestHandler & { locals: object }}
 */
function withToken(app, token) {
    const handler = (request, response) => {
        request.headers.authorization ??= `Bearer ${token}`;
        app(request, response);
    };
    handler.locals = app.locals;
    return handler;
}

/**
 * The whole application over a temporary database with the real schema, for
 * tests that send HTTP requests with supertest.
 *
 * Requests through `app` are made by the admin: tests of anything but access
 * rules need not log in. `rawApp` is the application without the token, for
 * tests of logging in and of other roles.
 *
 * @returns {Promise<{ app: Function, rawApp: import('express').Express, admin: object, adminToken: string, container: object, root: string, close: () => Promise<void> }>}
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
    const rawApp = createApp(database, {
        logger: createLogger({ level: 'silent' }),
        tokenSecret: TEST_TOKEN_SECRET,
        // the lowest cost of bcrypt: hashing at the real one slows tests down
        passwordRounds: 4,
    });
    const container = rawApp.locals.container;
    // as in server.js, the first admin is created in the empty database
    const admin = await container.services.auth.ensureAdmin(TEST_ADMIN);
    const { token: adminToken } = await container.services.auth.login(
        TEST_ADMIN.username,
        TEST_ADMIN.password
    );
    return {
        app: withToken(rawApp, adminToken),
        rawApp,
        admin,
        adminToken,
        container,
        root,
        close: async () => {
            await database.close();
            await removeDir(root);
        },
    };
}
