import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { createTestApp } from '../helpers/test-app.js';

describe('/api/educators', () => {
    let app;
    let container;
    let close;
    let repositories;

    beforeEach(async () => {
        ({ app, container, close } = await createTestApp());
        repositories = container.repositories;
    });

    afterEach(async () => close());

    const educator = (fields = {}) => ({
        firstName: 'Ірина',
        lastName: 'Мельник',
        ...fields,
    });
    const createEducator = async (fields) =>
        (
            await request(app)
                .post('/api/educators')
                .send(educator(fields))
                .expect(201)
        ).body;

    describe('GET /api/educators', () => {
        test('answers a page of educators', async () => {
            const created = await createEducator();

            const response = await request(app)
                .get('/api/educators')
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
            await createEducator({ lastName: 'Андрієнко' });
            const boiko = await createEducator({ lastName: 'Бойко' });
            await createEducator({ lastName: 'Василенко' });
            await createEducator({ firstName: 'Олег', lastName: 'Гнатюк' });

            // ACT
            const response = await request(app)
                .get('/api/educators')
                .query({
                    where: '{"firstName":"Ірина"}',
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
                .get('/api/educators')
                .query(query)
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_QUERY');
        });
    });

    describe('POST /api/educators', () => {
        test('answers 201 with the record and its Location', async () => {
            const response = await request(app)
                .post('/api/educators')
                .send(educator())
                .expect(201);

            expect(response.headers.location).toBe(
                `/api/educators/${response.body.id}`
            );
            expect(response.body).toMatchObject(educator());
            await request(app).get(response.headers.location).expect(200);
        });

        test('lists every invalid field at once', async () => {
            const response = await request(app)
                .post('/api/educators')
                .send({ firstName: '', email: 'a@b.c' })
                .expect(422);

            expect(response.body.error.code).toBe('VALIDATION_ERROR');
            expect(
                response.body.error.details.map(({ field }) => field).sort()
            ).toEqual(['email', 'firstName', 'lastName']);
        });

        test.each([
            ['an array', []],
            ['the id of the record', educator({ id: uuidv7() })],
        ])('answers 422 for %s', async (name, body) => {
            await request(app).post('/api/educators').send(body).expect(422);
        });

        test('answers 422 without a body', async () => {
            await request(app).post('/api/educators').expect(422);
        });

        test('stores nothing after an invalid request', async () => {
            await request(app)
                .post('/api/educators')
                .send(educator({ firstName: '' }))
                .expect(422);

            expect((await repositories.educators.findPage()).total).toBe(0);
        });
    });

    describe('GET /api/educators/:id', () => {
        test('answers the record', async () => {
            const created = await createEducator();

            const response = await request(app)
                .get(`/api/educators/${created.id}`)
                .expect(200);

            expect(response.body).toEqual(created);
        });

        test('answers 404 for a missing educator', async () => {
            const response = await request(app)
                .get(`/api/educators/${uuidv7()}`)
                .expect(404);

            expect(response.body.error.code).toBe('NOT_FOUND');
        });
    });

    describe('PUT /api/educators/:id', () => {
        test('replaces the record', async () => {
            const { id } = await createEducator();

            const response = await request(app)
                .put(`/api/educators/${id}`)
                .send(educator({ firstName: 'Оксана', lastName: 'Бойко' }))
                .expect(200);

            expect(response.body).toMatchObject({
                id,
                firstName: 'Оксана',
                lastName: 'Бойко',
            });
        });

        test('requires all the required fields', async () => {
            const { id } = await createEducator();

            await request(app)
                .put(`/api/educators/${id}`)
                .send({ firstName: 'Оксана' })
                .expect(422);
        });

        test('answers 404 for a missing educator', async () => {
            await request(app)
                .put(`/api/educators/${uuidv7()}`)
                .send(educator())
                .expect(404);
        });
    });

    describe('PATCH /api/educators/:id', () => {
        test('changes only the given fields', async () => {
            const { id } = await createEducator();

            const response = await request(app)
                .patch(`/api/educators/${id}`)
                .send({ firstName: 'Оксана' })
                .expect(200);

            expect(response.body).toMatchObject({
                firstName: 'Оксана',
                lastName: 'Мельник',
            });
        });

        test('rejects an invalid field', async () => {
            const { id } = await createEducator();

            const response = await request(app)
                .patch(`/api/educators/${id}`)
                .send({ lastName: '' })
                .expect(422);

            expect(response.body.error.details[0].field).toBe('lastName');
        });
    });

    describe('DELETE /api/educators/:id', () => {
        test('answers 204 without a body and leaves the group without an educator', async () => {
            // ARRANGE
            const { id } = await createEducator();
            const group = await repositories.groups.create({
                name: 'Сонечко',
                age: 3,
                educatorId: id,
            });

            // ACT
            const response = await request(app)
                .delete(`/api/educators/${id}`)
                .expect(204);

            // ASSERT
            expect(response.text).toBe('');
            await request(app).get(`/api/educators/${id}`).expect(404);
            expect(await repositories.groups.getById(group.id)).toMatchObject({
                educatorId: null,
            });
        });

        test('answers 404 for a missing educator', async () => {
            await request(app).delete(`/api/educators/${uuidv7()}`).expect(404);
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
                    container.services.educators,
                    serviceMethod
                );

                // ACT
                const client = request(app);
                const response = await client[method](`/api/educators/${id}`)
                    .send(method === 'put' ? educator() : undefined)
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
                .patch('/api/educators/abc')
                .send({ lastName: '' })
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_ID');
        });
    });
});
