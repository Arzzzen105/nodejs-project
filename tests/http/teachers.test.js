import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { createTestApp } from '../helpers/test-app.js';

describe('/api/teachers', () => {
    let app;
    let container;
    let close;
    let repositories;

    beforeEach(async () => {
        ({ app, container, close } = await createTestApp());
        repositories = container.repositories;
    });

    afterEach(async () => close());

    const teacher = (fields = {}) => ({
        firstName: 'Олена',
        lastName: 'Ткаченко',
        ...fields,
    });
    const createTeacher = async (fields) =>
        (
            await request(app)
                .post('/api/teachers')
                .send(teacher(fields))
                .expect(201)
        ).body;
    const createSubject = (name) => repositories.subjects.create({ name });

    describe('GET /api/teachers', () => {
        test('answers a page of teachers', async () => {
            const created = await createTeacher();

            const response = await request(app)
                .get('/api/teachers')
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
            await createTeacher({ lastName: 'Андрієнко' });
            const boiko = await createTeacher({ lastName: 'Бойко' });
            await createTeacher({ lastName: 'Василенко' });
            await createTeacher({ firstName: 'Олег', lastName: 'Гнатюк' });

            // ACT
            const response = await request(app)
                .get('/api/teachers')
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

        test('finds the teachers of a subject', async () => {
            // ARRANGE
            const music = await createSubject('Музика');
            const drawing = await createSubject('Малювання');
            const musician = await createTeacher({ subjectIds: [music.id] });
            await createTeacher({ subjectIds: [drawing.id] });

            // ACT
            const response = await request(app)
                .get('/api/teachers')
                .query({
                    where: JSON.stringify({
                        subjectIds: { contains: music.id },
                    }),
                })
                .expect(200);

            // ASSERT
            expect(response.body.items).toEqual([musician]);
        });

        test.each([
            ['broken where', { where: '{bad' }],
            ['limit that is not a number', { limit: 'abc' }],
            ['unknown parameter', { limt: '5' }],
            ['limit over the maximum, from the database', { limit: '501' }],
            ['unknown field, from the database', { where: '{"foo":1}' }],
        ])('answers 400 INVALID_QUERY for %s', async (name, query) => {
            const response = await request(app)
                .get('/api/teachers')
                .query(query)
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_QUERY');
        });
    });

    describe('POST /api/teachers', () => {
        test('answers 201 with the record and its Location', async () => {
            const response = await request(app)
                .post('/api/teachers')
                .send(teacher())
                .expect(201);

            expect(response.headers.location).toBe(
                `/api/teachers/${response.body.id}`
            );
            // the default comes from the database
            expect(response.body).toMatchObject({
                ...teacher(),
                subjectIds: [],
            });
            await request(app).get(response.headers.location).expect(200);
        });

        test('stores the subjects of the teacher', async () => {
            const music = await createSubject('Музика');
            const drawing = await createSubject('Малювання');

            const created = await createTeacher({
                subjectIds: [music.id, drawing.id],
            });

            expect(created.subjectIds).toEqual([music.id, drawing.id]);
        });

        test('lists every invalid field at once', async () => {
            const response = await request(app)
                .post('/api/teachers')
                .send({ firstName: '', subjectIds: ['abc'], foo: 1 })
                .expect(422);

            expect(response.body.error.code).toBe('VALIDATION_ERROR');
            expect(
                response.body.error.details.map(({ field }) => field).sort()
            ).toEqual(['firstName', 'foo', 'lastName', 'subjectIds.0']);
        });

        test('rejects the same subject twice', async () => {
            const music = await createSubject('Музика');

            const response = await request(app)
                .post('/api/teachers')
                .send(teacher({ subjectIds: [music.id, music.id] }))
                .expect(422);

            expect(response.body.error.details).toEqual([
                {
                    field: 'subjectIds',
                    message: 'Must not contain duplicates.',
                },
            ]);
        });

        test('rejects a subject id that is not a UUIDv7', async () => {
            const response = await request(app)
                .post('/api/teachers')
                .send(teacher({ subjectIds: [uuidv4()] }))
                .expect(422);

            expect(response.body.error.details[0].field).toBe('subjectIds.0');
        });

        test('leaves a reference to a missing subject to the database', async () => {
            const response = await request(app)
                .post('/api/teachers')
                .send(teacher({ subjectIds: [uuidv7()] }))
                .expect(422);

            expect(response.body.error.code).toBe('REFERENCE_NOT_FOUND');
        });

        test.each([
            ['an array', []],
            ['the id of the record', teacher({ id: uuidv7() })],
            ['subjectIds null', teacher({ subjectIds: null })],
        ])('answers 422 for %s', async (name, body) => {
            await request(app).post('/api/teachers').send(body).expect(422);
        });

        test('answers 422 without a body', async () => {
            await request(app).post('/api/teachers').expect(422);
        });

        test('stores nothing after an invalid request', async () => {
            await request(app)
                .post('/api/teachers')
                .send(teacher({ firstName: '' }))
                .expect(422);

            expect((await repositories.teachers.findPage()).total).toBe(0);
        });
    });

    describe('GET /api/teachers/:id', () => {
        test('answers the record', async () => {
            const created = await createTeacher();

            const response = await request(app)
                .get(`/api/teachers/${created.id}`)
                .expect(200);

            expect(response.body).toEqual(created);
        });

        test('answers 404 for a missing teacher', async () => {
            const response = await request(app)
                .get(`/api/teachers/${uuidv7()}`)
                .expect(404);

            expect(response.body.error.code).toBe('NOT_FOUND');
        });
    });

    describe('PUT /api/teachers/:id', () => {
        test('replaces the record: subjects not given are cleared', async () => {
            const music = await createSubject('Музика');
            const { id } = await createTeacher({ subjectIds: [music.id] });

            const response = await request(app)
                .put(`/api/teachers/${id}`)
                .send(teacher({ firstName: 'Оксана' }))
                .expect(200);

            expect(response.body).toMatchObject({
                id,
                firstName: 'Оксана',
                subjectIds: [],
            });
        });

        test('requires all the required fields', async () => {
            const { id } = await createTeacher();

            await request(app)
                .put(`/api/teachers/${id}`)
                .send({ firstName: 'Оксана' })
                .expect(422);
        });

        test('answers 404 for a missing teacher', async () => {
            await request(app)
                .put(`/api/teachers/${uuidv7()}`)
                .send(teacher())
                .expect(404);
        });
    });

    describe('PATCH /api/teachers/:id', () => {
        test('changes only the given fields', async () => {
            const music = await createSubject('Музика');
            const { id } = await createTeacher({ subjectIds: [music.id] });

            const response = await request(app)
                .patch(`/api/teachers/${id}`)
                .send({ firstName: 'Оксана' })
                .expect(200);

            expect(response.body).toMatchObject({
                firstName: 'Оксана',
                lastName: 'Ткаченко',
                subjectIds: [music.id],
            });
        });

        test('replaces the whole list of subjects', async () => {
            const music = await createSubject('Музика');
            const drawing = await createSubject('Малювання');
            const { id } = await createTeacher({ subjectIds: [music.id] });

            const response = await request(app)
                .patch(`/api/teachers/${id}`)
                .send({ subjectIds: [drawing.id] })
                .expect(200);

            expect(response.body.subjectIds).toEqual([drawing.id]);
        });

        test('rejects an invalid field', async () => {
            const { id } = await createTeacher();

            const response = await request(app)
                .patch(`/api/teachers/${id}`)
                .send({ lastName: '' })
                .expect(422);

            expect(response.body.error.details[0].field).toBe('lastName');
        });
    });

    describe('DELETE /api/teachers/:id', () => {
        test('answers 204 without a body', async () => {
            const { id } = await createTeacher();

            const response = await request(app)
                .delete(`/api/teachers/${id}`)
                .expect(204);

            expect(response.text).toBe('');
            await request(app).get(`/api/teachers/${id}`).expect(404);
        });

        test('answers 404 for a missing teacher', async () => {
            await request(app).delete(`/api/teachers/${uuidv7()}`).expect(404);
        });
    });

    describe('DELETE /api/subjects/:id', () => {
        test('removes the subject from its teachers and keeps the others', async () => {
            // ARRANGE
            const music = await createSubject('Музика');
            const drawing = await createSubject('Малювання');
            const { id } = await createTeacher({
                subjectIds: [music.id, drawing.id],
            });

            // ACT
            await request(app).delete(`/api/subjects/${music.id}`).expect(204);

            // ASSERT
            const response = await request(app)
                .get(`/api/teachers/${id}`)
                .expect(200);
            expect(response.body.subjectIds).toEqual([drawing.id]);
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
                    container.services.teachers,
                    serviceMethod
                );

                // ACT
                const client = request(app);
                const response = await client[method](`/api/teachers/${id}`)
                    .send(method === 'put' ? teacher() : undefined)
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
                .patch('/api/teachers/abc')
                .send({ lastName: '' })
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_ID');
        });
    });
});
