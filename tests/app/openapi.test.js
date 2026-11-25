import { describe, beforeAll, afterAll, test, expect } from 'vitest';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { createTestApp } from '../helpers/test-app.js';
import { createApiRouters } from '../../src/routes/api-routers.js';
import { collectOperations } from '../../src/openapi/collect.js';
import { keyOf } from '../../src/openapi/document.js';
import { OPERATIONS } from '../../src/openapi/operations/index.js';

describe('the API reference (NFR-08)', () => {
    let testApp;
    let document;
    let operations;

    beforeAll(async () => {
        testApp = await createTestApp();
        operations = collectOperations(
            createApiRouters(testApp.container.controllers, () => {})
        );
        ({ body: document } = await request(testApp.rawApp)
            .get('/api/openapi.json')
            .expect(200));
    });

    afterAll(async () => testApp.close());

    const operation = (method, path) => document.paths[path]?.[method];

    test('is open: the document and the page need no token', async () => {
        const page = await request(testApp.rawApp)
            .get('/api/docs/')
            .expect(200);

        expect(page.text).toContain('swagger-ui');
        expect(document).toMatchObject({
            openapi: '3.1.0',
            info: { title: 'Kindergarten API' },
        });
    });

    describe('covers the routes', () => {
        test('every route is described', () => {
            const missing = operations
                .map(keyOf)
                .filter((key) => !OPERATIONS[key]);

            expect(missing).toEqual([]);
        });

        test('every description is of a route', () => {
            const routes = new Set(operations.map(keyOf));

            expect(
                Object.keys(OPERATIONS).filter((key) => !routes.has(key))
            ).toEqual([]);
        });

        test('every router of the application is in the table the reference reads', () => {
            // routes of the application, but /health, the reference itself
            // and /api/test, which is no part of the API
            const counted = testApp.rawApp.router.stack
                .filter((layer) => layer.handle?.stack)
                .filter(
                    (layer) =>
                        !layer.handle.stack.some(
                            (l) => l.route?.path === '/openapi.json'
                        ) && !layer.matchers[0]('/api/test')
                )
                .flatMap((layer) => layer.handle.stack)
                .filter((layer) => layer.route)
                .flatMap((layer) => Object.keys(layer.route.methods));

            expect(counted).toHaveLength(operations.length);
        });

        test('every operation of the document reaches its route', async () => {
            const auth = {
                authorization: `Bearer ${testApp.adminToken}`,
            };
            for (const [path, methods] of Object.entries(document.paths)) {
                const url = path.replace(/\{\w+\}/g, uuidv7());
                for (const method of Object.keys(methods)) {
                    const client = request(testApp.rawApp);
                    const response = await client[method](url)
                        .set(auth)
                        .send({});

                    expect(
                        response.body?.error?.message,
                        `${method} ${path}`
                    ).not.toBe('Route not found.');
                }
            }
        });
    });

    describe('shows what the routes check', () => {
        test('the roles of authorize', () => {
            expect(operation('post', '/api/discounts')['x-roles']).toEqual([
                'ADMIN',
            ]);
            expect(operation('get', '/api/kids')['x-roles']).toEqual([
                'ADMIN',
                'MANAGER',
                'EDUCATOR',
                'PARENT',
            ]);
            // router.use(authorize(...)) applies to every route after it
            expect(operation('get', '/api/rooms/{id}')['x-roles']).toEqual([
                'ADMIN',
                'MANAGER',
            ]);
            expect(operation('get', '/api/rooms/{id}').description).toMatch(
                /^\*\*Roles:\*\* ADMIN, MANAGER\./
            );
        });

        test('whether a token is needed', () => {
            expect(operation('post', '/api/auth/login').security).toEqual([]);
            expect(operation('get', '/api/auth/me').security).toEqual([
                { bearer: [] },
            ]);
            expect(operation('get', '/api/auth/me')['x-roles']).toHaveLength(5);
            expect(operation('get', '/api/kids').security).toEqual([
                { bearer: [] },
            ]);
        });

        test('the body of validate', () => {
            const body = operation('post', '/api/kids').requestBody.content[
                'application/json'
            ].schema;

            expect(body.required).toEqual(
                expect.arrayContaining(['firstName', 'lastName', 'age', 'sex'])
            );
            expect(body.properties.age).toEqual({
                type: 'integer',
                minimum: 2,
                maximum: 5,
            });
            expect(body.additionalProperties).toBe(false);
        });

        test('the path and the query of validate', () => {
            const names = (method, path) =>
                operation(method, path).parameters.map((p) => [p.in, p.name]);

            expect(names('get', '/api/kids/{kidId}/notes/{id}')).toEqual([
                ['path', 'kidId'],
                ['path', 'id'],
            ]);
            expect(names('get', '/api/groups')).toEqual(
                expect.arrayContaining([
                    ['query', 'where'],
                    ['query', 'attendsSpeechLessons'],
                ])
            );
        });

        test('the errors every operation of its kind has, and its own', () => {
            const responses = operation('patch', '/api/kids/{id}').responses;

            expect(Object.keys(responses)).toEqual([
                '200',
                '400',
                '401',
                '403',
                '404',
                '409',
                '422',
            ]);
            expect(responses[409].description).toContain('GROUP_FULL');
            expect(responses[422].description).toContain('VALIDATION_ERROR');
            expect(
                operation('post', '/api/auth/login').responses
            ).not.toHaveProperty('403');
        });
    });

    describe('the records', () => {
        test('come from the schemas of the collections', () => {
            const kid = document.components.schemas.Kid;

            expect(kid.properties.age).toEqual({
                type: 'integer',
                minimum: 2,
                maximum: 5,
            });
            expect(kid.properties.groupId.type).toEqual(['string', 'null']);
            expect(kid.required).toEqual(
                expect.arrayContaining(['id', 'createdAt', 'firstName'])
            );
        });

        test('with the fields the API adds, without those it hides', () => {
            const { Group, User } = document.components.schemas;

            expect(Group.properties).toHaveProperty('attendsSpeechLessons');
            expect(User.properties).not.toHaveProperty('passwordHash');
        });

        test('every reference points to a schema of the document', () => {
            const refs = JSON.stringify(document).match(
                /#\/components\/schemas\/\w+/g
            );

            for (const ref of new Set(refs)) {
                expect(document.components.schemas, ref).toHaveProperty(
                    ref.split('/').at(-1)
                );
            }
        });
    });
});
