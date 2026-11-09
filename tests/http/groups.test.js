import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
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
