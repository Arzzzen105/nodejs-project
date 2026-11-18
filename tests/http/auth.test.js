import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, TEST_ADMIN } from '../helpers/test-app.js';

describe('/api/auth', () => {
    let rawApp;
    let admin;
    let adminToken;
    let container;
    let close;

    beforeEach(async () => {
        ({ rawApp, admin, adminToken, container, close } =
            await createTestApp());
    });

    afterEach(async () => close());

    describe('POST /api/auth/login', () => {
        test('answers a token, when it expires and the account', async () => {
            const response = await request(rawApp)
                .post('/api/auth/login')
                .send(TEST_ADMIN)
                .expect(200);

            expect(response.body).toEqual({
                token: expect.any(String),
                expiresAt: expect.any(String),
                user: admin,
            });
            expect(response.body.user).not.toHaveProperty('passwordHash');
        });

        test('the token opens the API', async () => {
            const { body } = await request(rawApp)
                .post('/api/auth/login')
                .send(TEST_ADMIN);

            await request(rawApp)
                .get('/api/kids')
                .set('authorization', `Bearer ${body.token}`)
                .expect(200);
        });

        test.each([
            ['a wrong password', { ...TEST_ADMIN, password: 'wrong' }],
            ['an unknown username', { ...TEST_ADMIN, username: 'nobody' }],
        ])('answers 401 INVALID_CREDENTIALS for %s', async (name, body) => {
            const response = await request(rawApp)
                .post('/api/auth/login')
                .send(body)
                .expect(401);

            expect(response.body.error).toEqual({
                code: 'INVALID_CREDENTIALS',
                message: 'The username or the password is wrong.',
            });
        });

        test.each([
            ['no body', undefined],
            ['no password', { username: 'admin' }],
            ['an empty username', { username: '', password: 'x' }],
            ['an unknown field', { ...TEST_ADMIN, role: 'ADMIN' }],
        ])('answers 422 VALIDATION_ERROR for %s', async (name, body) => {
            const response = await request(rawApp)
                .post('/api/auth/login')
                .send(body)
                .expect(422);

            expect(response.body.error.code).toBe('VALIDATION_ERROR');
        });
    });

    describe('GET /api/auth/me', () => {
        test('answers the account of the token', async () => {
            const response = await request(rawApp)
                .get('/api/auth/me')
                .set('authorization', `Bearer ${adminToken}`)
                .expect(200);

            expect(response.body).toEqual(admin);
        });

        test('answers 401 without a token', async () => {
            await request(rawApp).get('/api/auth/me').expect(401);
        });
    });

    describe('a token is required', () => {
        test.each([
            ['get', '/api/kids'],
            ['post', '/api/groups'],
            ['get', '/api/consistency'],
            ['get', '/api/test'],
            ['get', '/api/no-such-route'],
        ])(
            '%s %s answers 401 UNAUTHENTICATED without one',
            async (method, path) => {
                const client = request(rawApp);
                const response = await client[method](path).expect(401);

                expect(response.headers['www-authenticate']).toBe('Bearer');
                expect(response.body.error).toEqual({
                    code: 'UNAUTHENTICATED',
                    message: 'An access token is required.',
                });
            }
        );

        test.each([
            ['another scheme', `Basic ${adminToken}`],
            ['no token after the scheme', 'Bearer '],
        ])('answers 401 for a header with %s', async (name, header) => {
            await request(rawApp)
                .get('/api/kids')
                .set('authorization', header)
                .expect(401);
        });

        test('answers 401 for an invalid token', async () => {
            const response = await request(rawApp)
                .get('/api/kids')
                .set('authorization', 'Bearer not-a-token')
                .expect(401);

            expect(response.headers['www-authenticate']).toBe(
                'Bearer error="invalid_token"'
            );
            expect(response.body.error.code).toBe('UNAUTHENTICATED');
        });

        test('answers 401 for the token of a deleted account', async () => {
            // ARRANGE
            const manager = await container.services.users.create({
                username: 'manager',
                password: 'correct horse',
                role: 'MANAGER',
            });
            const { token } = await container.services.auth.login(
                'manager',
                'correct horse'
            );
            await container.services.users.delete(manager.id);

            // ACT + ASSERT
            await request(rawApp)
                .get('/api/kids')
                .set('authorization', `Bearer ${token}`)
                .expect(401);
        });

        test('a request without a token changes nothing', async () => {
            await request(rawApp)
                .post('/api/rooms')
                .send({ name: 'Gym' })
                .expect(401);

            expect((await container.repositories.rooms.findPage()).total).toBe(
                0
            );
        });

        test('/health needs no token', async () => {
            await request(rawApp).get('/health').expect(200);
        });
    });
});
