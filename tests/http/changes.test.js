import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { createTestApp } from '../helpers/test-app.js';

describe('GET /api/changes (FR-15)', () => {
    let app;
    let rawApp;
    let admin;
    let signIn;
    let repositories;
    let close;

    beforeEach(async () => {
        let container;
        ({ app, rawApp, admin, signIn, container, close } =
            await createTestApp());
        repositories = container.repositories;
    });

    afterEach(async () => close());

    const KID = {
        firstName: 'Marko',
        lastName: 'Koval',
        age: 3,
        sex: 'MALE',
    };
    const history = (query) =>
        request(app).get('/api/changes').query(query).expect(200);

    test('the history of a kid: created, changed, deleted, newest first, with who did it', async () => {
        // ARRANGE
        const { body: kid } = await request(app)
            .post('/api/kids')
            .send(KID)
            .expect(201);
        await request(app)
            .patch(`/api/kids/${kid.id}`)
            .send({ firstName: 'Taras' })
            .expect(200);
        await request(app).delete(`/api/kids/${kid.id}`).expect(204);

        // ACT
        const { body } = await history({ collection: 'kids', id: kid.id });

        // ASSERT
        expect(body.total).toBe(3);
        expect(body.items.map((c) => c.op)).toEqual([
            'delete',
            'update',
            'create',
        ]);
        const [deleted, updated, created] = body.items;
        expect(updated).toMatchObject({
            collection: 'kids',
            id: kid.id,
            changedFields: ['firstName'],
            before: { firstName: 'Marko' },
            after: { firstName: 'Taras' },
            userId: admin.id,
            user: { id: admin.id, username: 'admin', role: 'ADMIN' },
            requestId: expect.any(String),
        });
        expect(Date.parse(updated.at)).not.toBeNaN();
        expect(created).toMatchObject({ before: null, after: kid });
        expect(created.changedFields).toContain('firstName');
        expect(deleted).toMatchObject({
            before: { firstName: 'Taras' },
            after: null,
        });
    });

    test('a change by the rules of onDelete shares the transaction of the delete', async () => {
        const discount = await repositories.discounts.create({
            name: 'Large family',
            rate: 0.1,
        });
        const kid = await repositories.kids.create({
            ...KID,
            discountId: discount.id,
        });

        await request(app).delete(`/api/discounts/${discount.id}`).expect(204);

        const { body } = await history({
            op: 'delete',
            collection: 'discounts',
        });
        const [kidChange] = (
            await history({ collection: 'kids', id: kid.id, op: 'update' })
        ).body.items;
        expect(kidChange).toMatchObject({
            changedFields: ['discountId'],
            tx: body.items[0].tx,
        });
    });

    test('filters by the account that made the change', async () => {
        const manager = await signIn({ role: 'MANAGER' });
        await request(rawApp)
            .post('/api/kids')
            .set(manager.auth)
            .send(KID)
            .expect(201);
        await request(app)
            .post('/api/kids')
            .send({ ...KID, firstName: 'Olia', sex: 'FEMALE' })
            .expect(201);

        const { body } = await history({
            collection: 'kids',
            userId: manager.user.id,
        });

        expect(body.items).toHaveLength(1);
        expect(body.items[0]).toMatchObject({
            after: { firstName: 'Marko' },
            user: { username: manager.user.username, role: 'MANAGER' },
        });
    });

    test('filters by time', async () => {
        const before = new Date().toISOString();
        await request(app).post('/api/kids').send(KID).expect(201);
        const tomorrow = new Date(Date.now() + 86400000).toISOString();

        const since = await history({ collection: 'kids', from: before });
        const later = await history({ collection: 'kids', from: tomorrow });
        const until = await history({ collection: 'kids', to: before });

        expect(since.body.total).toBe(1);
        expect(later.body.total).toBe(0);
        expect(until.body.total).toBe(0);
    });

    test('a page of the history', async () => {
        for (const firstName of ['A', 'B', 'C']) {
            await request(app)
                .post('/api/kids')
                .send({ ...KID, firstName })
                .expect(201);
        }

        const { body } = await history({
            collection: 'kids',
            limit: 1,
            offset: 1,
        });

        expect(body).toMatchObject({ total: 3, limit: 1, offset: 1 });
        expect(body.items[0].after.firstName).toBe('B');
    });

    test('never shows the hash of a password', async () => {
        await request(app)
            .post('/api/users')
            .send({
                username: 'manager',
                password: 'manager-password',
                role: 'MANAGER',
            })
            .expect(201);

        const { body } = await history({ collection: 'users' });

        expect(body.total).toBeGreaterThan(0);
        expect(JSON.stringify(body)).not.toContain('passwordHash');
        expect(JSON.stringify(body)).not.toContain('$2');
    });

    test('a change outside a request has no user', async () => {
        const kid = await repositories.kids.create(KID);

        const { body } = await history({ id: kid.id });

        expect(body.items[0]).toMatchObject({
            userId: null,
            user: null,
            requestId: null,
        });
    });

    test('a deleted account is null, its id stays', async () => {
        const manager = await signIn({ role: 'MANAGER' });
        const { body: kid } = await request(rawApp)
            .post('/api/kids')
            .set(manager.auth)
            .send(KID)
            .expect(201);
        await request(app).delete(`/api/users/${manager.user.id}`).expect(204);

        const { body } = await history({ id: kid.id });

        expect(body.items[0]).toMatchObject({
            userId: manager.user.id,
            user: null,
        });
    });

    test.each([
        ['an unknown collection', { collection: 'cats' }],
        ['an id that is not one', { id: 'x' }],
        ['an unknown operation', { op: 'replace' }],
        ['a time without an offset', { from: '2026-11-01T00:00:00' }],
        ['a page too big', { limit: 501 }],
        ['an unknown parameter', { kidId: uuidv7() }],
    ])('answers 400 INVALID_QUERY for %s', async (name, query) => {
        const response = await request(app)
            .get('/api/changes')
            .query(query)
            .expect(400);

        expect(response.body.error.code).toBe('INVALID_QUERY');
    });

    test('is for the admin only', async () => {
        const manager = await signIn({ role: 'MANAGER' });

        await request(rawApp).get('/api/changes').set(manager.auth).expect(403);
    });
});
