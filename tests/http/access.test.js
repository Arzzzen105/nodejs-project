import { describe, beforeAll, afterAll, test, expect } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';

/**
 * Every route of the API but /api/auth and /api/users, which have tests of
 * their own. Ids are not UUIDs: a role that may use a route gets 400 or 422,
 * so no request of this file changes the database.
 */
const ROUTES = [
    ...['kids', 'parents', 'groups', 'educators', 'assistants']
        .concat(['teachers', 'rooms', 'subjects', 'discounts'])
        .flatMap((resource) => [
            ['get', `/api/${resource}`],
            ['post', `/api/${resource}`],
            ['get', `/api/${resource}/x`],
            ['put', `/api/${resource}/x`],
            ['patch', `/api/${resource}/x`],
            ['delete', `/api/${resource}/x`],
        ]),
    ['get', '/api/parents/x/kids'],
    ['get', '/api/groups/x/kids'],
    ['post', '/api/groups/x/kids'],
    ['get', '/api/groups/x/room'],
    ['get', '/api/groups/x/schedule'],
    ['get', '/api/teachers/x/schedule'],
    ['get', '/api/rooms/x/schedule'],
    ['get', '/api/educators/x/group'],
    ['get', '/api/assistants/x/group'],
    ['get', '/api/subjects/x/teachers'],
    ['get', '/api/subjects/x/rooms'],
    ['get', '/api/discounts/x/kids'],
    ['get', '/api/kids/x/price'],
    ['get', '/api/finance/settings'],
    ['patch', '/api/finance/settings'],
    ['get', '/api/finance/report'],
    ['post', '/api/finance/forecast'],
    ['get', '/api/schedules'],
    ['post', '/api/schedules'],
    ['get', '/api/schedules/draft'],
    ['get', '/api/schedules/published'],
    ['get', '/api/schedules/x'],
    ['patch', '/api/schedules/x/entries/x'],
    ['post', '/api/schedules/x/publish'],
    ['get', '/api/kids/x/notes'],
    ['post', '/api/kids/x/notes'],
    ['get', '/api/kids/x/notes/x'],
    ['put', '/api/kids/x/notes/x'],
    ['patch', '/api/kids/x/notes/x'],
    ['delete', '/api/kids/x/notes/x'],
    ['get', '/api/consistency'],
    ['get', '/api/consistency/kids'],
    ['get', '/api/test'],
];

/** What only the admin may do: change financial values, bypass the rules. */
const ADMIN_ONLY = [
    ['post', '/api/discounts'],
    ['put', '/api/discounts/x'],
    ['patch', '/api/discounts/x'],
    ['delete', '/api/discounts/x'],
    ['patch', '/api/finance/settings'],
    ['get', '/api/finance/report'],
    ['post', '/api/finance/forecast'],
    ['get', '/api/test'],
];

/**
 * What the other roles may reach. Which records are theirs is decided by
 * the services: tests/http/own-records.test.js.
 */
const OPEN = {
    EDUCATOR: [
        'get /api/kids',
        'get /api/kids/x',
        'get /api/parents',
        'get /api/parents/x',
        'get /api/parents/x/kids',
        'get /api/groups',
        'get /api/groups/x',
        'get /api/groups/x/kids',
        'get /api/groups/x/room',
        'get /api/groups/x/schedule',
        'get /api/educators/x',
        'get /api/educators/x/group',
        'get /api/kids/x/notes',
        'get /api/kids/x/notes/x',
    ],
    TEACHER: [
        'get /api/teachers/x',
        'get /api/teachers/x/schedule',
        'get /api/groups',
        'get /api/groups/x',
        'get /api/groups/x/kids',
        'get /api/schedules/draft',
        'get /api/schedules/published',
        'get /api/schedules/x',
        'patch /api/schedules/x/entries/x',
    ],
    PARENT: [
        'get /api/kids',
        'get /api/kids/x',
        'get /api/parents',
        'get /api/parents/x',
        'get /api/parents/x/kids',
        'get /api/groups',
        'get /api/groups/x',
        'get /api/groups/x/kids',
        'get /api/groups/x/schedule',
        'get /api/discounts/x',
        'get /api/kids/x/price',
        'get /api/kids/x/notes',
        'post /api/kids/x/notes',
        'get /api/kids/x/notes/x',
        'put /api/kids/x/notes/x',
        'patch /api/kids/x/notes/x',
        'delete /api/kids/x/notes/x',
    ],
};

const isOpen = (role, [method, path]) =>
    OPEN[role].includes(`${method} ${path}`);

const isAdminOnly = ([method, path]) =>
    ADMIN_ONLY.some(([m, p]) => m === method && p === path);

const send = (app, auth, [method, path]) => {
    const client = request(app);
    return client[method](path).set(auth).send({});
};

describe('access by role (TS-03.3)', () => {
    let testApp;
    const tokens = {};

    beforeAll(async () => {
        testApp = await createTestApp();
        const { repositories } = testApp.container;
        const person = { firstName: 'Ira', lastName: 'Bondar' };

        tokens.ADMIN = { authorization: `Bearer ${testApp.adminToken}` };
        tokens.MANAGER = (await testApp.signIn({ role: 'MANAGER' })).auth;
        tokens.EDUCATOR = (
            await testApp.signIn({
                role: 'EDUCATOR',
                educatorId: (await repositories.educators.create(person)).id,
            })
        ).auth;
        tokens.TEACHER = (
            await testApp.signIn({
                role: 'TEACHER',
                teacherId: (await repositories.teachers.create(person)).id,
            })
        ).auth;
        tokens.PARENT = (
            await testApp.signIn({
                role: 'PARENT',
                parentId: (
                    await repositories.parents.create({
                        ...person,
                        sex: 'FEMALE',
                    })
                ).id,
            })
        ).auth;
    });

    afterAll(async () => testApp.close());

    describe.each(['ADMIN', 'MANAGER'])('%s', (role) => {
        test.each(
            ROUTES.filter((route) => role === 'ADMIN' || !isAdminOnly(route))
        )('%s %s is allowed', async (method, path) => {
            const response = await send(testApp.rawApp, tokens[role], [
                method,
                path,
            ]);

            expect(response.status).not.toBe(401);
            expect(response.status).not.toBe(403);
        });
    });

    describe('MANAGER', () => {
        test.each(ADMIN_ONLY)('%s %s answers 403', async (method, path) => {
            const response = await send(testApp.rawApp, tokens.MANAGER, [
                method,
                path,
            ]);

            expect(response.status).toBe(403);
            expect(response.body.error.code).toBe('FORBIDDEN');
        });
    });

    describe.each(['EDUCATOR', 'TEACHER', 'PARENT'])('%s', (role) => {
        test('every open route exists', () => {
            for (const route of OPEN[role]) {
                const [method, path] = route.split(' ');
                expect(ROUTES, route).toContainEqual([method, path]);
            }
        });

        test.each(ROUTES.filter((route) => isOpen(role, route)))(
            '%s %s is allowed',
            async (method, path) => {
                const response = await send(testApp.rawApp, tokens[role], [
                    method,
                    path,
                ]);

                expect(response.status).not.toBe(401);
                expect(response.status).not.toBe(403);
            }
        );

        test.each(ROUTES.filter((route) => !isOpen(role, route)))(
            '%s %s answers 403 before the request is checked',
            async (method, path) => {
                const response = await send(testApp.rawApp, tokens[role], [
                    method,
                    path,
                ]);

                expect(response.status).toBe(403);
                expect(response.body.error.code).toBe('FORBIDDEN');
            }
        );

        test('GET /api/auth/me is allowed', async () => {
            await request(testApp.rawApp)
                .get('/api/auth/me')
                .set(tokens[role])
                .expect(200);
        });
    });
});

describe('the discount of a kid (BR-26)', () => {
    let testApp;
    let manager;
    let discount;
    let other;

    const kid = (fields = {}) => ({
        firstName: 'Marko',
        lastName: 'Koval',
        age: 3,
        sex: 'MALE',
        ...fields,
    });

    beforeAll(async () => {
        testApp = await createTestApp();
        manager = (await testApp.signIn({ role: 'MANAGER' })).auth;
        const { discounts } = testApp.container.repositories;
        discount = await discounts.create({ name: 'Large family', rate: 0.2 });
        other = await discounts.create({ name: 'Veteran', rate: 0.3 });
    });

    afterAll(async () => testApp.close());

    const createKid = (fields) =>
        testApp.container.repositories.kids.create(kid(fields));
    const kidCount = async () =>
        (await testApp.container.repositories.kids.findPage()).total;

    test('the admin assigns it', async () => {
        const response = await request(testApp.app)
            .post('/api/kids')
            .send(kid({ discountId: discount.id }))
            .expect(201);

        expect(response.body.discountId).toBe(discount.id);
    });

    test('the manager registers a kid without one', async () => {
        await request(testApp.rawApp)
            .post('/api/kids')
            .set(manager)
            .send(kid({ discountId: null }))
            .expect(201);
    });

    test('the manager cannot register a kid with one', async () => {
        const before = await kidCount();

        const response = await request(testApp.rawApp)
            .post('/api/kids')
            .set(manager)
            .send(kid({ discountId: discount.id }))
            .expect(403);

        expect(response.body.error).toEqual({
            code: 'FORBIDDEN',
            message:
                'Only the admin changes the discount and the payment plan of a kid.',
        });
        expect(await kidCount()).toBe(before);
    });

    test.each([
        ['assign', null, 'discount'],
        ['change', 'discount', 'other'],
        ['remove', 'discount', null],
    ])('PATCH: the manager cannot %s it', async (name, from, to) => {
        // ARRANGE
        const ids = { discount: discount.id, other: other.id };
        const { id } = await createKid({ discountId: ids[from] ?? null });

        // ACT
        await request(testApp.rawApp)
            .patch(`/api/kids/${id}`)
            .set(manager)
            .send({ discountId: ids[to] ?? null })
            .expect(403);

        // ASSERT
        const stored = await testApp.container.repositories.kids.getById(id);
        expect(stored.discountId).toBe(ids[from] ?? null);
    });

    test('PATCH: the manager changes other fields of a kid with a discount', async () => {
        const { id } = await createKid({ discountId: discount.id });

        const response = await request(testApp.rawApp)
            .patch(`/api/kids/${id}`)
            .set(manager)
            .send({ firstName: 'Taras', discountId: discount.id })
            .expect(200);

        expect(response.body).toMatchObject({
            firstName: 'Taras',
            discountId: discount.id,
        });
    });

    test('PUT: the manager keeps the discount by sending it', async () => {
        const { id } = await createKid({ discountId: discount.id });

        await request(testApp.rawApp)
            .put(`/api/kids/${id}`)
            .set(manager)
            .send(kid({ firstName: 'Taras', discountId: discount.id }))
            .expect(200);
    });

    test('PUT: leaving the discount out would remove it, so the manager gets 403', async () => {
        const { id } = await createKid({ discountId: discount.id });

        await request(testApp.rawApp)
            .put(`/api/kids/${id}`)
            .set(manager)
            .send(kid({ firstName: 'Taras' }))
            .expect(403);
    });

    test('the admin changes and removes it', async () => {
        const { id } = await createKid({ discountId: discount.id });

        await request(testApp.app)
            .patch(`/api/kids/${id}`)
            .send({ discountId: other.id })
            .expect(200);
        await request(testApp.app)
            .patch(`/api/kids/${id}`)
            .send({ discountId: null })
            .expect(200);
    });
});
