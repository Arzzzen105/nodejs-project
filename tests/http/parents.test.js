import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { createTestApp } from '../helpers/test-app.js';

describe('/api/parents', () => {
    let app;
    let container;
    let close;
    let repositories;

    beforeEach(async () => {
        ({ app, container, close } = await createTestApp());
        repositories = container.repositories;
    });

    afterEach(async () => close());

    const parent = (fields = {}) => ({
        firstName: 'Олена',
        lastName: 'Коваленко',
        sex: 'FEMALE',
        workplace: 'Школа',
        email: 'olena@example.com',
        phone: '+380501234567',
        ...fields,
    });

    const createParent = async (fields) =>
        (
            await request(app)
                .post('/api/parents')
                .send(parent(fields))
                .expect(201)
        ).body;

    describe('GET /api/parents', () => {
        test('answers a page of parents', async () => {
            const created = await createParent();

            const response = await request(app).get('/api/parents').expect(200);

            expect(response.body).toEqual({
                items: [created],
                total: 1,
                limit: 100,
                offset: 0,
            });
        });

        test('filters, sorts and pages by the query string', async () => {
            // ARRANGE
            await createParent({ lastName: 'Андрієнко' });
            const boiko = await createParent({ lastName: 'Бойко' });
            await createParent({ lastName: 'Василенко' });
            await createParent({
                firstName: 'Олег',
                lastName: 'Гнатюк',
                sex: 'MALE',
            });

            // ACT
            const response = await request(app)
                .get('/api/parents')
                .query({
                    where: '{"firstName":"Олена"}',
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
                .get('/api/parents')
                .query(query)
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_QUERY');
        });
    });

    describe('POST /api/parents', () => {
        test('answers 201 with the record and its Location', async () => {
            const response = await request(app)
                .post('/api/parents')
                .send(parent())
                .expect(201);

            expect(response.headers.location).toBe(
                `/api/parents/${response.body.id}`
            );
            expect(response.body).toMatchObject(parent());
            await request(app).get(response.headers.location).expect(200);
        });

        test('lists every invalid field at once', async () => {
            const response = await request(app)
                .post('/api/parents')
                .send({
                    firstName: '',
                    lastName: '',
                    sex: 'INVALID',
                    email: 'invalid-email',
                    phone: '123',
                })
                .expect(422);

            expect(response.body.error.code).toBe('VALIDATION_ERROR');
            expect(
                response.body.error.details.map(({ field }) => field).sort()
            ).toEqual(['email', 'firstName', 'lastName', 'phone', 'sex']);
        });

        test.each([
            ['an array', []],
            ['the id of the record', parent({ id: uuidv7() })],
        ])('answers 422 for %s', async (name, body) => {
            await request(app).post('/api/parents').send(body).expect(422);
        });

        test('answers 422 without a body', async () => {
            await request(app).post('/api/parents').expect(422);
        });

        test('stores nothing after an invalid request', async () => {
            await request(app)
                .post('/api/parents')
                .send(parent({ firstName: '' }))
                .expect(422);

            expect((await repositories.parents.findPage()).total).toBe(0);
        });
    });

    describe('GET /api/parents/:id', () => {
        test('answers the record', async () => {
            const created = await createParent();

            const response = await request(app)
                .get(`/api/parents/${created.id}`)
                .expect(200);

            expect(response.body).toEqual(created);
        });

        test('answers 404 for a missing parent', async () => {
            const response = await request(app)
                .get(`/api/parents/${uuidv7()}`)
                .expect(404);

            expect(response.body.error.code).toBe('NOT_FOUND');
        });
    });

    describe('PUT /api/parents/:id', () => {
        test('replaces the record', async () => {
            const { id } = await createParent();

            const response = await request(app)
                .put(`/api/parents/${id}`)
                .send(parent({ firstName: 'Оксана', lastName: 'Бойко' }))
                .expect(200);

            expect(response.body).toMatchObject({
                id,
                firstName: 'Оксана',
                lastName: 'Бойко',
            });
        });

        test('requires all the required fields', async () => {
            const { id } = await createParent();

            await request(app)
                .put(`/api/parents/${id}`)
                .send({ firstName: 'Оксана' })
                .expect(422);
        });

        test('answers 404 for a missing parent', async () => {
            await request(app)
                .put(`/api/parents/${uuidv7()}`)
                .send(parent())
                .expect(404);
        });
    });

    describe('PATCH /api/parents/:id', () => {
        test('changes only the given fields', async () => {
            const { id } = await createParent();

            const response = await request(app)
                .patch(`/api/parents/${id}`)
                .send({ firstName: 'Оксана' })
                .expect(200);

            expect(response.body).toMatchObject({
                firstName: 'Оксана',
                lastName: 'Коваленко',
            });
        });

        test('rejects an invalid field', async () => {
            const { id } = await createParent();

            const response = await request(app)
                .patch(`/api/parents/${id}`)
                .send({ email: 'bad-email' })
                .expect(422);

            expect(response.body.error.details[0].field).toBe('email');
        });
    });

    describe('DELETE /api/parents/:id', () => {
        test('answers 204 without a body', async () => {
            const { id } = await createParent();

            const response = await request(app)
                .delete(`/api/parents/${id}`)
                .expect(204);

            expect(response.text).toBe('');
            await request(app).get(`/api/parents/${id}`).expect(404);
        });

        test('answers 404 for a missing parent', async () => {
            await request(app).delete(`/api/parents/${uuidv7()}`).expect(404);
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
                const spy = vi.spyOn(container.services.parents, serviceMethod);

                // ACT
                const client = request(app);
                const response = await client[method](`/api/parents/${id}`)
                    .send(method === 'put' ? parent() : undefined)
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
                .patch('/api/parents/abc')
                .send({ email: 'bad-email' })
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_ID');
        });
    });
});
