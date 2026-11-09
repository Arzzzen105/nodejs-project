import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { createTestApp } from '../helpers/test-app.js';

describe('/api/kids/:kidId/notes', () => {
    let app;
    let container;
    let close;
    let repositories;
    let kid;
    let other;

    beforeEach(async () => {
        ({ app, container, close } = await createTestApp());
        repositories = container.repositories;
        kid = await createKid('Марко');
        other = await createKid('Остап');
    });

    afterEach(async () => close());

    const createKid = (firstName) =>
        repositories.kids.create({
            firstName,
            lastName: 'Коваль',
            age: 3,
            sex: 'MALE',
        });
    const notesOf = (kidId) => `/api/kids/${kidId}/notes`;
    const note = (fields = {}) => ({ text: 'Алергія на горіхи', ...fields });
    const createNote = async (kidId, fields) =>
        (await request(app).post(notesOf(kidId)).send(note(fields)).expect(201))
            .body;

    describe('GET /api/kids/:kidId/notes', () => {
        test('answers a page of the notes of the kid only', async () => {
            const created = await createNote(kid.id);
            await createNote(other.id);

            const response = await request(app)
                .get(notesOf(kid.id))
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
            await createNote(kid.id, { text: 'А' });
            const b = await createNote(kid.id, { text: 'Б' });
            await createNote(kid.id, { text: 'В' });
            await createNote(other.id, { text: 'Б' });

            // ACT
            const response = await request(app)
                .get(notesOf(kid.id))
                .query({
                    where: '{"text":{"in":["А","Б"]}}',
                    sort: '-text',
                    limit: '1',
                    offset: '0',
                })
                .expect(200);

            // ASSERT
            expect(response.body).toMatchObject({
                total: 2,
                limit: 1,
                offset: 0,
            });
            expect(response.body.items).toEqual([b]);
        });

        test('keeps to the kid of the path when where names another kid', async () => {
            await createNote(other.id);

            const response = await request(app)
                .get(notesOf(kid.id))
                .query({ where: JSON.stringify({ kidId: other.id }) })
                .expect(200);

            expect(response.body.total).toBe(0);
        });

        test('answers an empty page for a kid without notes', async () => {
            const response = await request(app)
                .get(notesOf(kid.id))
                .expect(200);

            expect(response.body.items).toEqual([]);
        });

        test('answers 404 for a missing kid', async () => {
            const response = await request(app)
                .get(notesOf(uuidv7()))
                .expect(404);

            expect(response.body.error.code).toBe('NOT_FOUND');
        });

        test.each([
            ['broken where', { where: '{bad' }],
            ['limit that is not a number', { limit: 'abc' }],
            ['unknown parameter', { limt: '5' }],
            ['limit over the maximum, from the database', { limit: '501' }],
            ['unknown field, from the database', { where: '{"foo":1}' }],
        ])('answers 400 INVALID_QUERY for %s', async (name, query) => {
            const response = await request(app)
                .get(notesOf(kid.id))
                .query(query)
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_QUERY');
        });
    });

    describe('POST /api/kids/:kidId/notes', () => {
        test('answers 201 with the note of the kid and its Location', async () => {
            const response = await request(app)
                .post(notesOf(kid.id))
                .send(note())
                .expect(201);

            expect(response.headers.location).toBe(
                `${notesOf(kid.id)}/${response.body.id}`
            );
            expect(response.body).toMatchObject({ ...note(), kidId: kid.id });
            await request(app).get(response.headers.location).expect(200);
        });

        test('takes the kid from the path, not from the body', async () => {
            const response = await request(app)
                .post(notesOf(kid.id))
                .send(note({ kidId: other.id }))
                .expect(422);

            expect(response.body.error.details).toEqual([
                { field: 'kidId', message: 'Unknown field.' },
            ]);
        });

        test('lists every invalid field at once', async () => {
            const response = await request(app)
                .post(notesOf(kid.id))
                .send({ text: '', foo: 1 })
                .expect(422);

            expect(response.body.error.code).toBe('VALIDATION_ERROR');
            expect(
                response.body.error.details.map(({ field }) => field).sort()
            ).toEqual(['foo', 'text']);
        });

        test.each([
            ['an array', []],
            ['the id of the record', note({ id: uuidv7() })],
            ['a text of 201', note({ text: 'x'.repeat(201) })],
        ])('answers 422 for %s', async (name, body) => {
            await request(app).post(notesOf(kid.id)).send(body).expect(422);
        });

        test('answers 422 without a body', async () => {
            await request(app).post(notesOf(kid.id)).expect(422);
        });

        test('answers 404 for a missing kid and stores nothing', async () => {
            const response = await request(app)
                .post(notesOf(uuidv7()))
                .send(note())
                .expect(404);

            expect(response.body.error.code).toBe('NOT_FOUND');
            expect((await repositories.notes.findPage()).total).toBe(0);
        });
    });

    describe('GET /api/kids/:kidId/notes/:id', () => {
        test('answers the note', async () => {
            const created = await createNote(kid.id);

            const response = await request(app)
                .get(`${notesOf(kid.id)}/${created.id}`)
                .expect(200);

            expect(response.body).toEqual(created);
        });

        test('answers 404 for a missing note', async () => {
            const response = await request(app)
                .get(`${notesOf(kid.id)}/${uuidv7()}`)
                .expect(404);

            expect(response.body.error.code).toBe('NOT_FOUND');
        });

        test('answers 404 for a note of another kid', async () => {
            const { id } = await createNote(other.id);

            const response = await request(app)
                .get(`${notesOf(kid.id)}/${id}`)
                .expect(404);

            expect(response.body.error.code).toBe('NOT_FOUND');
        });
    });

    describe('PUT /api/kids/:kidId/notes/:id', () => {
        test('replaces the note and keeps its kid', async () => {
            const { id } = await createNote(kid.id);

            const response = await request(app)
                .put(`${notesOf(kid.id)}/${id}`)
                .send({ text: 'Не їсть молочне' })
                .expect(200);

            expect(response.body).toMatchObject({
                id,
                text: 'Не їсть молочне',
                kidId: kid.id,
            });
        });

        test('requires all the required fields', async () => {
            const { id } = await createNote(kid.id);

            await request(app)
                .put(`${notesOf(kid.id)}/${id}`)
                .send({})
                .expect(422);
        });
    });

    describe('PATCH /api/kids/:kidId/notes/:id', () => {
        test('changes the text', async () => {
            const { id } = await createNote(kid.id);

            const response = await request(app)
                .patch(`${notesOf(kid.id)}/${id}`)
                .send({ text: 'Не їсть молочне' })
                .expect(200);

            expect(response.body).toMatchObject({
                text: 'Не їсть молочне',
                kidId: kid.id,
            });
        });

        test('cannot move the note to another kid', async () => {
            const { id } = await createNote(kid.id);

            await request(app)
                .patch(`${notesOf(kid.id)}/${id}`)
                .send({ kidId: other.id })
                .expect(422);

            expect((await repositories.notes.getById(id)).kidId).toBe(kid.id);
        });

        test('rejects an invalid field', async () => {
            const { id } = await createNote(kid.id);

            const response = await request(app)
                .patch(`${notesOf(kid.id)}/${id}`)
                .send({ text: '' })
                .expect(422);

            expect(response.body.error.details[0].field).toBe('text');
        });
    });

    describe('DELETE /api/kids/:kidId/notes/:id', () => {
        test('answers 204 without a body and keeps the kid', async () => {
            const { id } = await createNote(kid.id);

            const response = await request(app)
                .delete(`${notesOf(kid.id)}/${id}`)
                .expect(204);

            expect(response.text).toBe('');
            await request(app)
                .get(`${notesOf(kid.id)}/${id}`)
                .expect(404);
            await request(app).get(`/api/kids/${kid.id}`).expect(200);
        });
    });

    describe('a note of another kid', () => {
        test.each([
            ['put', note({ text: 'Чуже' })],
            ['patch', { text: 'Чуже' }],
            ['delete', undefined],
        ])('%s answers 404 and leaves it as it is', async (method, body) => {
            // ARRANGE
            const theirs = await createNote(other.id);

            // ACT
            const client = request(app);
            const response = await client[method](
                `${notesOf(kid.id)}/${theirs.id}`
            )
                .send(body)
                .expect(404);

            // ASSERT
            expect(response.body.error.code).toBe('NOT_FOUND');
            expect(await repositories.notes.getById(theirs.id)).toEqual(theirs);
        });
    });

    test('deleting the kid deletes their notes (FR-018)', async () => {
        await createNote(kid.id);
        const theirs = await createNote(other.id);

        await request(app).delete(`/api/kids/${kid.id}`).expect(204);

        expect((await repositories.notes.findPage()).items).toEqual([theirs]);
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
                ['garbage note id', () => kid.id, 'abc', 'id'],
                ['UUIDv4 note id', () => kid.id, uuidv4(), 'id'],
                ['garbage kid id', () => 'abc', uuidv7(), 'kidId'],
            ])(
                '%s stops before the service',
                async (name, kidId, id, field) => {
                    // ARRANGE
                    const spy = vi.spyOn(
                        container.services.notes,
                        serviceMethod
                    );

                    // ACT
                    const client = request(app);
                    const response = await client[method](
                        `${notesOf(kidId())}/${id}`
                    )
                        .send(method === 'put' ? note() : undefined)
                        .expect(400);

                    // ASSERT
                    expect(response.body.error.code).toBe('INVALID_ID');
                    expect(response.body.error.details[0].field).toBe(field);
                    expect(spy).not.toHaveBeenCalled();
                }
            );
        });

        test.each([['get'], ['post']])(
            '%s of the list checks the kid id',
            async (method) => {
                const spy = vi.spyOn(
                    container.services.notes,
                    method === 'get' ? 'list' : 'create'
                );

                const client = request(app);
                const response = await client[method](notesOf('abc'))
                    .send(method === 'post' ? note() : undefined)
                    .expect(400);

                expect(response.body.error.code).toBe('INVALID_ID');
                expect(spy).not.toHaveBeenCalled();
            }
        );

        test('is reported before an invalid body', async () => {
            const response = await request(app)
                .patch(`${notesOf(kid.id)}/abc`)
                .send({ text: '' })
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_ID');
        });
    });
});
