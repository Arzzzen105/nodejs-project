import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { createTestApp } from '../helpers/test-app.js';

describe('/api/assistants', () => {
    let app;
    let container;
    let close;
    let repositories;

    beforeEach(async () => {
        ({ app, container, close } = await createTestApp());
        repositories = container.repositories;
    });

    afterEach(async () => close());

    const assistant = (fields = {}) => ({
        firstName: 'Тетяна',
        lastName: 'Шевчук',
        ...fields,
    });
    const createAssistant = async (fields) =>
        (
            await request(app)
                .post('/api/assistants')
                .send(assistant(fields))
                .expect(201)
        ).body;

    describe('GET /api/assistants', () => {
        test('answers a page of assistants', async () => {
            const created = await createAssistant();

            const response = await request(app)
                .get('/api/assistants')
                .expect(200);

            expect(response.body).toEqual({
                items: [created],
                total: 1,
                limit: 100,
                offset: 0,
            });
        });

        test('filters, sorts and pages by the query string', async () => {
            // ARRANGE
            await createAssistant({ lastName: 'Андрієнко' });
            const boiko = await createAssistant({ lastName: 'Бойко' });
            await createAssistant({ lastName: 'Василенко' });
            await createAssistant({ firstName: 'Олег', lastName: 'Гнатюк' });

            // ACT
            const response = await request(app)
                .get('/api/assistants')
                .query({
                    where: '{"firstName":"Тетяна"}',
                    sort: '-lastName',
                    limit: '1',
                    offset: '1',
                })
                .expect(200);

            // ASSERT
            expect(response.body).toMatchObject({
                total: 3,
                limit: 1,
                offset: 1,
            });
            expect(response.body.items).toEqual([boiko]);
        });

        test.each([
            ['broken where', { where: '{bad' }],
            ['limit that is not a number', { limit: 'abc' }],
            ['unknown parameter', { limt: '5' }],
            ['limit over the maximum, from the database', { limit: '501' }],
            ['unknown field, from the database', { where: '{"foo":1}' }],
        ])('answers 400 INVALID_QUERY for %s', async (name, query) => {
            const response = await request(app)
                .get('/api/assistants')
                .query(query)
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_QUERY');
        });
    });

    describe('POST /api/assistants', () => {
        test('answers 201 with the record and its Location', async () => {
            const response = await request(app)
                .post('/api/assistants')
                .send(assistant())
                .expect(201);

            expect(response.headers.location).toBe(
                `/api/assistants/${response.body.id}`
            );
            expect(response.body).toMatchObject(assistant());
            await request(app).get(response.headers.location).expect(200);
        });

        test('lists every invalid field at once', async () => {
            const response = await request(app)
                .post('/api/assistants')
                .send({ firstName: '', email: 'a@b.c' })
                .expect(422);

            expect(response.body.error.code).toBe('VALIDATION_ERROR');
            expect(
                response.body.error.details.map(({ field }) => field).sort()
            ).toEqual(['email', 'firstName', 'lastName']);
        });

        test.each([
            ['an array', []],
            ['the id of the record', assistant({ id: uuidv7() })],
        ])('answers 422 for %s', async (name, body) => {
            await request(app).post('/api/assistants').send(body).expect(422);
        });

        test('answers 422 without a body', async () => {
            await request(app).post('/api/assistants').expect(422);
        });

        test('stores nothing after an invalid request', async () => {
            await request(app)
                .post('/api/assistants')
                .send(assistant({ firstName: '' }))
                .expect(422);

            expect((await repositories.assistants.findPage()).total).toBe(0);
        });
    });

    describe('GET /api/assistants/:id', () => {
        test('answers the record', async () => {
            const created = await createAssistant();

            const response = await request(app)
                .get(`/api/assistants/${created.id}`)
                .expect(200);

            expect(response.body).toEqual(created);
        });

        test('answers 404 for a missing assistant', async () => {
            const response = await request(app)
                .get(`/api/assistants/${uuidv7()}`)
                .expect(404);

            expect(response.body.error.code).toBe('NOT_FOUND');
        });
    });

    describe('PUT /api/assistants/:id', () => {
        test('replaces the record', async () => {
            const { id } = await createAssistant();

            const response = await request(app)
                .put(`/api/assistants/${id}`)
                .send(assistant({ firstName: 'Наталія', lastName: 'Бойко' }))
                .expect(200);

            expect(response.body).toMatchObject({
                id,
                firstName: 'Наталія',
                lastName: 'Бойко',
            });
        });

        test('requires all the required fields', async () => {
            const { id } = await createAssistant();

            await request(app)
                .put(`/api/assistants/${id}`)
                .send({ firstName: 'Наталія' })
                .expect(422);
        });

        test('answers 404 for a missing assistant', async () => {
            await request(app)
                .put(`/api/assistants/${uuidv7()}`)
                .send(assistant())
                .expect(404);
        });
    });

    describe('PATCH /api/assistants/:id', () => {
        test('changes only the given fields', async () => {
            const { id } = await createAssistant();

            const response = await request(app)
                .patch(`/api/assistants/${id}`)
                .send({ firstName: 'Наталія' })
                .expect(200);

            expect(response.body).toMatchObject({
                firstName: 'Наталія',
                lastName: 'Шевчук',
            });
        });

        test('rejects an invalid field', async () => {
            const { id } = await createAssistant();

            const response = await request(app)
                .patch(`/api/assistants/${id}`)
                .send({ lastName: '' })
                .expect(422);

            expect(response.body.error.details[0].field).toBe('lastName');
        });
    });

    describe('DELETE /api/assistants/:id', () => {
        test('answers 204 without a body and leaves the group without an assistant', async () => {
            // ARRANGE
            const { id } = await createAssistant();
            const group = await repositories.groups.create({
                name: 'Сонечко',
                age: 3,
                assistantId: id,
            });

            // ACT
            const response = await request(app)
                .delete(`/api/assistants/${id}`)
                .expect(204);

            // ASSERT
            expect(response.text).toBe('');
            await request(app).get(`/api/assistants/${id}`).expect(404);
            expect(await repositories.groups.getById(group.id)).toMatchObject({
                assistantId: null,
            });
        });

        test('answers 404 for a missing assistant', async () => {
            await request(app)
                .delete(`/api/assistants/${uuidv7()}`)
                .expect(404);
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
                // ARRANGE
                const spy = vi.spyOn(
                    container.services.assistants,
                    serviceMethod
                );

                // ACT
                const client = request(app);
                const response = await client[method](`/api/assistants/${id}`)
                    .send(method === 'put' ? assistant() : undefined)
                    .expect(400);

                // ASSERT
                expect(response.body.error.code).toBe('INVALID_ID');
                expect(response.body.error.message).toBe(
                    '"id" must be a UUID.'
                );
                expect(spy).not.toHaveBeenCalled();
            });
        });

        test('is reported before an invalid body', async () => {
            const response = await request(app)
                .patch('/api/assistants/abc')
                .send({ lastName: '' })
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_ID');
        });
    });
});
