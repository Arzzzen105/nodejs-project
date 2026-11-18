import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { createTestApp } from '../helpers/test-app.js';

describe('/api/users', () => {
    let app;
    let rawApp;
    let admin;
    let signIn;
    let container;
    let close;

    beforeEach(async () => {
        ({ app, rawApp, admin, signIn, container, close } =
            await createTestApp());
    });

    afterEach(async () => close());

    const account = (fields = {}) => ({
        username: 'manager',
        password: 'correct horse',
        role: 'MANAGER',
        ...fields,
    });

    const createParent = () =>
        container.repositories.parents.create({
            firstName: 'Olena',
            lastName: 'Koval',
            sex: 'FEMALE',
        });

    const accountCount = async () =>
        (await container.repositories.users.findPage()).total;

    describe('POST /api/users', () => {
        test('answers 201 with the account and its Location', async () => {
            const response = await request(app)
                .post('/api/users')
                .send(account())
                .expect(201);

            expect(response.headers.location).toBe(
                `/api/users/${response.body.id}`
            );
            expect(response.body).toMatchObject({
                username: 'manager',
                role: 'MANAGER',
            });
            expect(response.body).not.toHaveProperty('password');
            expect(response.body).not.toHaveProperty('passwordHash');
        });

        test('the registered account can log in (BR-66)', async () => {
            await request(app).post('/api/users').send(account()).expect(201);

            await request(rawApp)
                .post('/api/auth/login')
                .send({ username: 'manager', password: 'correct horse' })
                .expect(200);
        });

        test('registers a parent linked to their record', async () => {
            const parent = await createParent();

            const response = await request(app)
                .post('/api/users')
                .send(
                    account({
                        username: 'olena',
                        role: 'PARENT',
                        parentId: parent.id,
                    })
                )
                .expect(201);

            expect(response.body.parentId).toBe(parent.id);
        });

        test('lists every invalid field at once', async () => {
            const response = await request(app)
                .post('/api/users')
                .send({ username: 'A', password: 'short', role: 'BOSS' })
                .expect(422);

            // "A" is too short and has a capital letter: two details
            const fields = response.body.error.details.map(
                ({ field }) => field
            );
            expect([...new Set(fields)].sort()).toEqual([
                'password',
                'role',
                'username',
            ]);
        });

        test('answers 422 USER_PERSON_MISMATCH for a parent without a person', async () => {
            const response = await request(app)
                .post('/api/users')
                .send(account({ role: 'PARENT' }))
                .expect(422);

            expect(response.body.error.code).toBe('USER_PERSON_MISMATCH');
        });

        test('answers 409 for a taken username', async () => {
            await request(app).post('/api/users').send(account()).expect(201);

            const response = await request(app)
                .post('/api/users')
                .send(account({ password: 'another password' }))
                .expect(409);

            expect(response.body.error.code).toBe('UNIQUE_VIOLATION');
        });

        describe('who registers whom (BR-64, BR-65)', () => {
            test.each(['ADMIN', 'MANAGER', 'EDUCATOR', 'TEACHER', 'PARENT'])(
                'the admin registers a %s',
                async (role) => {
                    // ARRANGE
                    const links = {
                        EDUCATOR: async () => ({
                            educatorId: (
                                await container.repositories.educators.create({
                                    firstName: 'Iryna',
                                    lastName: 'Bondar',
                                })
                            ).id,
                        }),
                        TEACHER: async () => ({
                            teacherId: (
                                await container.repositories.teachers.create({
                                    firstName: 'Petro',
                                    lastName: 'Shevchuk',
                                })
                            ).id,
                        }),
                        PARENT: async () => ({
                            parentId: (await createParent()).id,
                        }),
                    };

                    // ACT + ASSERT
                    await request(app)
                        .post('/api/users')
                        .send(
                            account({
                                username: 'someone',
                                role,
                                ...(await links[role]?.()),
                            })
                        )
                        .expect(201);
                }
            );

            test('the manager registers a parent', async () => {
                const manager = await signIn({ role: 'MANAGER' });
                const parent = await createParent();

                await request(rawApp)
                    .post('/api/users')
                    .set(manager.auth)
                    .send(
                        account({
                            username: 'olena',
                            role: 'PARENT',
                            parentId: parent.id,
                        })
                    )
                    .expect(201);
            });

            test.each(['ADMIN', 'MANAGER'])(
                'the manager cannot register a %s and nothing is stored',
                async (role) => {
                    // ARRANGE
                    const manager = await signIn({ role: 'MANAGER' });
                    const before = await accountCount();

                    // ACT
                    const response = await request(rawApp)
                        .post('/api/users')
                        .set(manager.auth)
                        .send(account({ username: 'someone', role }))
                        .expect(403);

                    // ASSERT
                    expect(response.body.error).toEqual({
                        code: 'FORBIDDEN',
                        message: `A MANAGER cannot register a ${role} account.`,
                    });
                    expect(await accountCount()).toBe(before);
                }
            );
        });
    });

    describe('GET /api/users', () => {
        test('answers a page of accounts without password hashes', async () => {
            await request(app).post('/api/users').send(account()).expect(201);

            const response = await request(app).get('/api/users').expect(200);

            expect(response.body.total).toBe(2);
            expect(response.body.items.map(({ username }) => username)).toEqual(
                ['admin', 'manager']
            );
            for (const user of response.body.items) {
                expect(user).not.toHaveProperty('passwordHash');
            }
        });

        test('filters by role', async () => {
            await request(app).post('/api/users').send(account()).expect(201);

            const response = await request(app)
                .get('/api/users')
                .query({ where: '{"role":"MANAGER"}' })
                .expect(200);

            expect(response.body.items).toHaveLength(1);
        });

        test('answers 400 INVALID_QUERY for a broken where', async () => {
            await request(app)
                .get('/api/users')
                .query({ where: '{bad' })
                .expect(400);
        });
    });

    describe('GET /api/users/:id', () => {
        test('answers the account', async () => {
            const response = await request(app)
                .get(`/api/users/${admin.id}`)
                .expect(200);

            expect(response.body).toEqual(admin);
        });

        test('answers 404 for a missing account', async () => {
            await request(app).get(`/api/users/${uuidv7()}`).expect(404);
        });
    });

    describe('DELETE /api/users/:id', () => {
        test('answers 204, and the account cannot log in any more', async () => {
            const { body } = await request(app)
                .post('/api/users')
                .send(account());

            await request(app).delete(`/api/users/${body.id}`).expect(204);

            await request(rawApp)
                .post('/api/auth/login')
                .send({ username: 'manager', password: 'correct horse' })
                .expect(401);
        });

        test('leaves the person of the account', async () => {
            const parent = await createParent();
            const { user } = await signIn({
                role: 'PARENT',
                parentId: parent.id,
            });

            await request(app).delete(`/api/users/${user.id}`).expect(204);

            await request(app).get(`/api/parents/${parent.id}`).expect(200);
        });

        test('nobody deletes their own account: 409 CANNOT_DELETE_SELF', async () => {
            const response = await request(app)
                .delete(`/api/users/${admin.id}`)
                .expect(409);

            expect(response.body.error.code).toBe('CANNOT_DELETE_SELF');
            expect(await accountCount()).toBe(1);
        });

        test.each(['ADMIN', 'MANAGER'])(
            'the manager cannot delete a %s',
            async (role) => {
                // ARRANGE
                const manager = await signIn({ role: 'MANAGER' });
                const { user } = await signIn({ role });

                // ACT
                await request(rawApp)
                    .delete(`/api/users/${user.id}`)
                    .set(manager.auth)
                    .expect(403);

                // ASSERT
                await request(app).get(`/api/users/${user.id}`).expect(200);
            }
        );

        test('the manager deletes a parent account', async () => {
            const manager = await signIn({ role: 'MANAGER' });
            const { user } = await signIn({
                role: 'PARENT',
                parentId: (await createParent()).id,
            });

            await request(rawApp)
                .delete(`/api/users/${user.id}`)
                .set(manager.auth)
                .expect(204);
        });

        test('the admin deletes another admin', async () => {
            const { user } = await signIn({ role: 'ADMIN' });

            await request(app).delete(`/api/users/${user.id}`).expect(204);
        });

        test('answers 404 for a missing account', async () => {
            await request(app).delete(`/api/users/${uuidv7()}`).expect(404);
        });
    });

    test.each(['put', 'patch'])(
        'the username and the password cannot be changed: %s answers 404 (BR-67)',
        async (method) => {
            const client = request(app);

            await client[method](`/api/users/${admin.id}`)
                .send({ password: 'new password' })
                .expect(404);
        }
    );

    describe('access', () => {
        const ROUTES = [
            ['get', () => '/api/users'],
            ['post', () => '/api/users'],
            ['get', () => `/api/users/${admin.id}`],
            ['delete', () => `/api/users/${admin.id}`],
        ];

        describe.each([
            ['EDUCATOR', 'educators', 'educatorId'],
            ['TEACHER', 'teachers', 'teacherId'],
            ['PARENT', 'parents', 'parentId'],
        ])('%s', (role, collection, field) => {
            test.each(ROUTES)(
                '%s answers 403 before the service',
                async (method, path) => {
                    // ARRANGE
                    const person = await container.repositories[
                        collection
                    ].create({
                        firstName: 'Ira',
                        lastName: 'Bondar',
                        ...(role === 'PARENT' && { sex: 'FEMALE' }),
                    });
                    const { auth } = await signIn({ role, [field]: person.id });
                    const spies = ['list', 'create', 'get', 'delete'].map(
                        (name) => vi.spyOn(container.services.users, name)
                    );

                    // ACT
                    const client = request(rawApp);
                    const response = await client[method](path())
                        .set(auth)
                        .send(account({ username: 'someone' }))
                        .expect(403);

                    // ASSERT
                    expect(response.body.error.code).toBe('FORBIDDEN');
                    for (const spy of spies) {
                        expect(spy).not.toHaveBeenCalled();
                    }
                }
            );
        });

        test('a forbidden role learns nothing about the body', async () => {
            const parent = await createParent();
            const { auth } = await signIn({
                role: 'PARENT',
                parentId: parent.id,
            });

            await request(rawApp)
                .post('/api/users')
                .set(auth)
                .send({ bad: true })
                .expect(403);
        });
    });

    describe('invalid id', () => {
        test.each([
            ['get', 'garbage', 'abc'],
            ['delete', 'garbage', 'abc'],
            ['get', 'UUIDv4', uuidv4()],
            ['delete', 'UUIDv4', uuidv4()],
        ])('%s with %s answers 400 INVALID_ID', async (method, name, id) => {
            const client = request(app);
            const response = await client[method](`/api/users/${id}`).expect(
                400
            );

            expect(response.body.error.code).toBe('INVALID_ID');
        });
    });
});
