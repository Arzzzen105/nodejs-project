import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { MAX_GROUPS } from '../../src/services/group-service.js';
import { MAX_GROUP_SIZE } from '../../src/services/kid-service.js';
import { createReadyGroup } from '../helpers/ready-group.js';
import { createTestApp } from '../helpers/test-app.js';

describe('/api/groups', () => {
    let app;
    let container;
    let close;
    let repositories;

    beforeEach(async () => {
        ({ app, container, close } = await createTestApp());
        repositories = container.repositories;
    });

    afterEach(async () => close());

    const group = (fields = {}) => ({
        name: 'Сонечко',
        age: 3,
        ...fields,
    });

    const createGroup = async (fields) =>
        (await request(app).post('/api/groups').send(group(fields)).expect(201))
            .body;

    describe('GET /api/groups', () => {
        test('answers a page of groups', async () => {
            const created = await createGroup();

            const response = await request(app).get('/api/groups').expect(200);

            expect(response.body).toEqual({
                items: [created],
                total: 1,
                limit: 100,
                offset: 0,
            });
        });

        test('filters, sorts and pages by the query string', async () => {
            await createGroup({ name: 'Абрикос', age: 2 });
            const three = await createGroup({ name: 'Берізка', age: 3 });
            await createGroup({ name: 'Віночок', age: 4 });

            const response = await request(app)
                .get('/api/groups')
                .query({
                    where: '{"age":{"gte":3}}',
                    sort: 'name',
                    limit: '1',
                    offset: '0',
                })
                .expect(200);

            expect(response.body).toMatchObject({
                total: 2,
                limit: 1,
                offset: 0,
            });
            expect(response.body.items).toEqual([three]);
        });
    });

    describe('POST /api/groups', () => {
        test('answers 201 with the record and its Location', async () => {
            const response = await request(app)
                .post('/api/groups')
                .send(group())
                .expect(201);

            expect(response.headers.location).toBe(
                `/api/groups/${response.body.id}`
            );
            expect(response.body).toMatchObject({
                ...group(),
                educatorId: null,
                assistantId: null,
            });
            await request(app).get(response.headers.location).expect(200);
        });

        test('lists every invalid field at once', async () => {
            const response = await request(app)
                .post('/api/groups')
                .send({ name: '', age: 99, foo: 1 })
                .expect(422);

            expect(response.body.error.code).toBe('VALIDATION_ERROR');
            expect(
                response.body.error.details.map(({ field }) => field).sort()
            ).toEqual(['age', 'foo', 'name']);
        });

        test.each([
            ['an array', []],
            ['the id of the record', group({ id: uuidv7() })],
        ])('answers 422 for %s', async (name, body) => {
            await request(app).post('/api/groups').send(body).expect(422);
        });

        test('answers 422 without a body', async () => {
            await request(app).post('/api/groups').expect(422);
        });

        test('stores nothing after an invalid request', async () => {
            await request(app)
                .post('/api/groups')
                .send(group({ age: 99 }))
                .expect(422);

            expect((await repositories.groups.findPage()).total).toBe(0);
        });

        test.each([['educatorId'], ['assistantId']])(
            'rejects a %s that is not a UUIDv7',
            async (field) => {
                const response = await request(app)
                    .post('/api/groups')
                    .send(group({ [field]: uuidv4() }))
                    .expect(422);

                expect(response.body.error.code).toBe('VALIDATION_ERROR');
                expect(response.body.error.details[0].field).toBe(field);
            }
        );

        test('leaves a reference to a missing record to the database', async () => {
            const response = await request(app)
                .post('/api/groups')
                .send(group({ educatorId: uuidv7() }))
                .expect(422);

            expect(response.body.error.code).toBe('REFERENCE_NOT_FOUND');
        });

        test('rejects a group over the limit (BR-19)', async () => {
            for (let i = 0; i < MAX_GROUPS; i++) {
                await repositories.groups.create({
                    name: `Group ${i}`,
                    age: 3,
                });
            }

            const response = await request(app)
                .post('/api/groups')
                .send(group({ name: 'Зайва' }))
                .expect(409);

            expect(response.body.error.code).toBe('GROUP_LIMIT_REACHED');
        });

        test('rejects assigning the same educator to a second group (1-to-1 rule)', async () => {
            const educator = await repositories.educators.create({
                firstName: 'Ірина',
                lastName: 'Мельник',
            });

            await request(app)
                .post('/api/groups')
                .send({
                    name: 'Сонечко',
                    age: 3,
                    educatorId: educator.id,
                })
                .expect(201);

            const response = await request(app)
                .post('/api/groups')
                .send({
                    name: 'Веселка',
                    age: 4,
                    educatorId: educator.id,
                })
                .expect(409);

            expect(response.body.error.code).toBeDefined();
        });

        test('rejects assigning the same assistant to a second group (1-to-1 rule)', async () => {
            const assistant = await repositories.assistants.create({
                firstName: 'Марія',
                lastName: 'Іванівна',
            });

            await request(app)
                .post('/api/groups')
                .send({
                    name: 'Сонечко',
                    age: 3,
                    assistantId: assistant.id,
                })
                .expect(201);

            const response = await request(app)
                .post('/api/groups')
                .send({
                    name: 'Веселка',
                    age: 4,
                    assistantId: assistant.id,
                })
                .expect(409);

            expect(response.body.error.code).toBeDefined();
        });
    });

    describe('POST /api/groups/:id/kids (FR-020)', () => {
        const storeKid = (fields = {}) =>
            repositories.kids.create({
                firstName: 'Марко',
                lastName: 'Коваль',
                age: 3,
                sex: 'MALE',
                ...fields,
            });

        test('answers 200 with the kids, now in the group', async () => {
            const ready = await createReadyGroup(repositories);
            const a = await storeKid();
            const b = await storeKid({ firstName: 'Остап' });

            const response = await request(app)
                .post(`/api/groups/${ready.id}/kids`)
                .send({ kidIds: [a.id, b.id] })
                .expect(200);

            expect(response.body.items).toEqual([
                { ...a, groupId: ready.id, updatedAt: expect.any(String) },
                { ...b, groupId: ready.id, updatedAt: expect.any(String) },
            ]);
            const kids = await request(app)
                .get(`/api/groups/${ready.id}/kids`)
                .expect(200);
            expect(kids.body.total).toBe(2);
        });

        test('lists every kid that cannot join', async () => {
            const ready = await createReadyGroup(repositories);
            const fits = await storeKid();
            const older = await storeKid({ age: 4 });

            const response = await request(app)
                .post(`/api/groups/${ready.id}/kids`)
                .send({ kidIds: [fits.id, older.id, uuidv7()] })
                .expect(422);

            expect(response.body.error.code).toBe('KIDS_CANNOT_JOIN');
            expect(
                response.body.error.details.map(({ field }) => field)
            ).toEqual(['kidIds.1', 'kidIds.2']);
        });

        test('answers the rules of the group: not ready, full', async () => {
            // ARRANGE
            const bare = await createGroup();
            const ready = await createReadyGroup(repositories);
            for (let i = 0; i < MAX_GROUP_SIZE; i++) {
                await storeKid({ groupId: ready.id });
            }
            const { id } = await storeKid();

            // ACT
            const notReady = await request(app)
                .post(`/api/groups/${bare.id}/kids`)
                .send({ kidIds: [id] });
            const full = await request(app)
                .post(`/api/groups/${ready.id}/kids`)
                .send({ kidIds: [id] });

            // ASSERT
            expect(notReady.status).toBe(409);
            expect(notReady.body.error.code).toBe('GROUP_NOT_READY');
            expect(full.status).toBe(409);
            expect(full.body.error.code).toBe('GROUP_FULL');
        });

        test.each([
            ['no kidIds', {}],
            ['an empty list', { kidIds: [] }],
            ['a repeated kid', { kidIds: ['R', 'R'] }],
            ['an id that is not a UUIDv7', { kidIds: [uuidv4()] }],
            ['an unknown field', { kidIds: ['K'], foo: 1 }],
        ])('answers 422 VALIDATION_ERROR for %s', async (name, body) => {
            // ARRANGE: placeholders stand for a real kid
            const ready = await createReadyGroup(repositories);
            const { id } = await storeKid();
            const fill = (ids) =>
                ids?.map((value) => (['R', 'K'].includes(value) ? id : value));

            // ACT
            const response = await request(app)
                .post(`/api/groups/${ready.id}/kids`)
                .send({
                    ...body,
                    ...(body.kidIds && { kidIds: fill(body.kidIds) }),
                })
                .expect(422);

            // ASSERT
            expect(response.body.error.code).toBe('VALIDATION_ERROR');
            expect((await repositories.kids.getById(id)).groupId).toBeNull();
        });

        test('answers 404 for a missing group', async () => {
            const { id } = await storeKid();

            await request(app)
                .post(`/api/groups/${uuidv7()}/kids`)
                .send({ kidIds: [id] })
                .expect(404);
        });

        test('stops a malformed group id before the service', async () => {
            const spy = vi.spyOn(container.services.groups, 'addKids');

            const response = await request(app)
                .post('/api/groups/abc/kids')
                .send({ kidIds: [uuidv7()] })
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_ID');
            expect(spy).not.toHaveBeenCalled();
        });
    });

    describe('GET /api/groups/:id', () => {
        test('answers the record', async () => {
            const created = await createGroup();

            const response = await request(app)
                .get(`/api/groups/${created.id}`)
                .expect(200);

            expect(response.body).toEqual(created);
        });

        test('answers 404 for a missing group', async () => {
            const response = await request(app)
                .get(`/api/groups/${uuidv7()}`)
                .expect(404);

            expect(response.body.error.code).toBe('NOT_FOUND');
        });
    });

    describe('PUT /api/groups/:id', () => {
        test('replaces the record: fields not given get their defaults', async () => {
            const educator = await repositories.educators.create({
                firstName: 'Анна',
                lastName: 'Петрівна',
            });
            const { id } = await createGroup({ educatorId: educator.id });

            const response = await request(app)
                .put(`/api/groups/${id}`)
                .send(group({ name: 'Веселка' }))
                .expect(200);

            expect(response.body).toMatchObject({
                id,
                name: 'Веселка',
                educatorId: null,
            });
        });
    });

    describe('PATCH /api/groups/:id', () => {
        test('changes only the given fields', async () => {
            const educator = await repositories.educators.create({
                firstName: 'Анна',
                lastName: 'Петрівна',
            });
            const { id } = await createGroup({ educatorId: educator.id });

            const response = await request(app)
                .patch(`/api/groups/${id}`)
                .send({ name: 'Веселка' })
                .expect(200);

            expect(response.body).toMatchObject({
                name: 'Веселка',
                age: 3,
                educatorId: educator.id,
            });
        });
    });

    describe('DELETE /api/groups/:id', () => {
        test('answers 204 without a body', async () => {
            const created = await createGroup();

            const response = await request(app)
                .delete(`/api/groups/${created.id}`)
                .expect(204);

            expect(response.text).toBe('');
            await request(app).get(`/api/groups/${created.id}`).expect(404);
        });

        test('sets educatorId and assistantId to null when referenced records are deleted (onDelete: setNull)', async () => {
            const educator = await repositories.educators.create({
                firstName: 'Анна',
                lastName: 'Петрівна',
            });
            const assistant = await repositories.assistants.create({
                firstName: 'Марія',
                lastName: 'Іванівна',
            });

            const createdGroup = await repositories.groups.create({
                name: 'Калинка',
                age: 3,
                educatorId: educator.id,
                assistantId: assistant.id,
            });

            await repositories.educators.delete(educator.id);
            await repositories.assistants.delete(assistant.id);

            const updatedGroup = await repositories.groups.findById(
                createdGroup.id
            );
            expect(updatedGroup).toMatchObject({
                educatorId: null,
                assistantId: null,
            });
        });
    });

    describe('invalid id', () => {
        const ROUTES = [
            ['get', 'get'],
            ['put', 'replace'],
            ['patch', 'update'],
            ['delete', 'delete'],
        ];

        describe.each(ROUTES)('%s', (method, serviceMethod) => {
            test.each([
                ['garbage', 'abc'],
                ['UUIDv4', uuidv4()],
            ])('%s stops before the service', async (name, id) => {
                const spy = vi.spyOn(container.services.groups, serviceMethod);

                const client = request(app);
                const response = await client[method](`/api/groups/${id}`)
                    .send(method === 'put' ? group() : undefined)
                    .expect(400);

                expect(response.body.error.code).toBe('INVALID_ID');
                expect(response.body.error.message).toBe(
                    '"id" must be a UUID.'
                );
                expect(spy).not.toHaveBeenCalled();
            });
        });
    });
});
