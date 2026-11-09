import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { createTestApp } from '../helpers/test-app.js';

describe('/api/subjects', () => {
    let app;
    let container;
    let close;
    let repositories;

    beforeEach(async () => {
        ({ app, container, close } = await createTestApp());
        repositories = container.repositories;
    });

    afterEach(async () => close());

    const subject = (fields = {}) => ({ name: 'Музика', ...fields });
    const createSubject = async (fields) =>
        (
            await request(app)
                .post('/api/subjects')
                .send(subject(fields))
                .expect(201)
        ).body;

    describe('GET /api/subjects', () => {
        test('answers a page of subjects', async () => {
            const created = await createSubject();

            const response = await request(app)
                .get('/api/subjects')
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
            await createSubject({ name: 'Англійська' });
            await createSubject({ name: 'Логіка' });
            const music = await createSubject({ name: 'Музика' });
            await createSubject({ name: 'Фізкультура' });

            // ACT
            const response = await request(app)
                .get('/api/subjects')
                .query({
                    where: '{"name":{"in":["Англійська","Логіка","Музика"]}}',
                    sort: '-name',
                    limit: '1',
                    offset: '0',
                })
                .expect(200);

            // ASSERT
            expect(response.body).toMatchObject({
                total: 3,
                limit: 1,
                offset: 0,
            });
            expect(response.body.items).toEqual([music]);
        });

        test.each([
            ['broken where', { where: '{bad' }],
            ['limit that is not a number', { limit: 'abc' }],
            ['unknown parameter', { limt: '5' }],
            ['limit over the maximum, from the database', { limit: '501' }],
            ['unknown field, from the database', { where: '{"foo":1}' }],
        ])('answers 400 INVALID_QUERY for %s', async (name, query) => {
            const response = await request(app)
                .get('/api/subjects')
                .query(query)
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_QUERY');
        });
    });

    describe('POST /api/subjects', () => {
        test('answers 201 with the record and its Location', async () => {
            const response = await request(app)
                .post('/api/subjects')
                .send(subject())
                .expect(201);

            expect(response.headers.location).toBe(
                `/api/subjects/${response.body.id}`
            );
            expect(response.body).toMatchObject(subject());
            await request(app).get(response.headers.location).expect(200);
        });

        test('lists every invalid field at once', async () => {
            const response = await request(app)
                .post('/api/subjects')
                .send({ name: '', foo: 1 })
                .expect(422);

            expect(response.body.error.code).toBe('VALIDATION_ERROR');
            expect(
                response.body.error.details.map(({ field }) => field).sort()
            ).toEqual(['foo', 'name']);
        });

        test.each([
            ['an array', []],
            ['the id of the record', subject({ id: uuidv7() })],
        ])('answers 422 for %s', async (name, body) => {
            await request(app).post('/api/subjects').send(body).expect(422);
        });

        test('answers 422 without a body', async () => {
            await request(app).post('/api/subjects').expect(422);
        });

        test('stores nothing after an invalid request', async () => {
            await request(app)
                .post('/api/subjects')
                .send(subject({ name: '' }))
                .expect(422);

            expect((await repositories.subjects.findPage()).total).toBe(0);
        });

        test('rejects a name that is already taken', async () => {
            await createSubject();

            const response = await request(app)
                .post('/api/subjects')
                .send(subject())
                .expect(409);

            expect(response.body.error.code).toBe('UNIQUE_VIOLATION');
        });
    });

    describe('GET /api/subjects/:id', () => {
        test('answers the record', async () => {
            const created = await createSubject();

            const response = await request(app)
                .get(`/api/subjects/${created.id}`)
                .expect(200);

            expect(response.body).toEqual(created);
        });

        test('answers 404 for a missing subject', async () => {
            const response = await request(app)
                .get(`/api/subjects/${uuidv7()}`)
                .expect(404);

            expect(response.body.error.code).toBe('NOT_FOUND');
        });
    });

    describe('PUT /api/subjects/:id', () => {
        test('replaces the record', async () => {
            const { id } = await createSubject();

            const response = await request(app)
                .put(`/api/subjects/${id}`)
                .send(subject({ name: 'Малювання' }))
                .expect(200);

            expect(response.body).toEqual({ id, name: 'Малювання' });
        });

        test('requires all the required fields', async () => {
            const { id } = await createSubject();

            await request(app).put(`/api/subjects/${id}`).send({}).expect(422);
        });

        test('answers 404 for a missing subject', async () => {
            await request(app)
                .put(`/api/subjects/${uuidv7()}`)
                .send(subject())
                .expect(404);
        });
    });

    describe('PATCH /api/subjects/:id', () => {
        test('changes the given fields', async () => {
            const { id } = await createSubject();

            const response = await request(app)
                .patch(`/api/subjects/${id}`)
                .send({ name: 'Малювання' })
                .expect(200);

            expect(response.body).toEqual({ id, name: 'Малювання' });
        });

        test('rejects an invalid field', async () => {
            const { id } = await createSubject();

            const response = await request(app)
                .patch(`/api/subjects/${id}`)
                .send({ name: 'x'.repeat(31) })
                .expect(422);

            expect(response.body.error.details[0].field).toBe('name');
        });

        test('rejects a name that is already taken', async () => {
            await createSubject({ name: 'Малювання' });
            const { id } = await createSubject();

            await request(app)
                .patch(`/api/subjects/${id}`)
                .send({ name: 'Малювання' })
                .expect(409);
        });
    });

    describe('DELETE /api/subjects/:id', () => {
        test('answers 204 without a body', async () => {
            const { id } = await createSubject();

            const response = await request(app)
                .delete(`/api/subjects/${id}`)
                .expect(204);

            expect(response.text).toBe('');
            await request(app).get(`/api/subjects/${id}`).expect(404);
        });

        test('answers 404 for a missing subject', async () => {
            await request(app).delete(`/api/subjects/${uuidv7()}`).expect(404);
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
                    container.services.subjects,
                    serviceMethod
                );

                // ACT
                const client = request(app);
                const response = await client[method](`/api/subjects/${id}`)
                    .send(method === 'put' ? subject() : undefined)
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
                .patch('/api/subjects/abc')
                .send({ name: '' })
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_ID');
        });
    });
});
