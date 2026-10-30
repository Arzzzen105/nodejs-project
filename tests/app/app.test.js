import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/logger.js';
import { createTestApp } from '../helpers/test-app.js';

describe('createApp', () => {
    let app;
    let close;

    beforeEach(async () => {
        ({ app, close } = await createTestApp());
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await close();
    });

    test('answers broken JSON with 400 INVALID_JSON', async () => {
        const response = await request(app)
            .post('/api/kids')
            .set('content-type', 'application/json')
            .send('{bad');

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('INVALID_JSON');
    });

    test('answers a body over the limit with 413 PAYLOAD_TOO_LARGE', async () => {
        const response = await request(app)
            .post('/api/kids')
            .send({ firstName: 'x'.repeat(1024 * 1024 + 1) });

        expect(response.status).toBe(413);
        expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    test('answers an unknown route with 404', async () => {
        const response = await request(app).get('/api/nothing');

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
    });

    test('hides the cause of an unexpected error', async () => {
        // ARRANGE
        vi.spyOn(app.locals.container.services.kids, 'list').mockRejectedValue(
            new Error('secret path /etc/app')
        );

        // ACT
        const response = await request(app).get('/api/kids');

        // ASSERT
        expect(response.status).toBe(500);
        expect(response.body).toEqual({
            error: {
                code: 'INTERNAL_ERROR',
                message: 'An internal server error occurred.',
            },
        });
    });

    describe('/api/test', () => {
        const build = () =>
            createApp(app.locals.database, {
                logger: createLogger({ level: 'silent' }),
            });

        test('is available outside production', async () => {
            vi.stubEnv('NODE_ENV', 'development');

            await request(build()).get('/api/test').expect(200);
        });

        test('does not exist in production', async () => {
            vi.stubEnv('NODE_ENV', 'production');

            await request(build()).get('/api/test').expect(404);
            await request(build()).post('/api/test/kids').send({}).expect(404);
        });
    });
});
