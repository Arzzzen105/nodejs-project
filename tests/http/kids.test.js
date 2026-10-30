import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { MAX_GROUP_SIZE } from '../../src/services/kid-service.js';
import { createTestApp } from '../helpers/test-app.js';

describe('/api/kids', () => {
    let app;
    let container;
    let close;
    let repositories;

    beforeEach(async () => {
        ({ app, container, close } = await createTestApp());
        repositories = container.repositories;
    });

    afterEach(async () => close());

    const kid = (fields = {}) => ({
        firstName: 'Марко',
        lastName: 'Коваль',
        age: 3,
        sex: 'MALE',
        ...fields,
    });
    const createKid = async (fields) =>
        (await request(app).post('/api/kids').send(kid(fields)).expect(201))
            .body;

    describe('GET /api/kids', () => {
        test('answers a page of kids', async () => {
            const created = await createKid();

            const response = await request(app).get('/api/kids').expect(200);

            expect(response.body).toEqual({
                items: [created],
                total: 1,
                limit: 100,
                offset: 0,
            });
        });

        test('filters, sorts and pages by the query string', async () => {
            // ARRANGE
            await createKid({ age: 2 });
            const three = await createKid({ age: 3 });
            await createKid({ age: 4 });

            // ACT
            const response = await request(app)
                .get('/api/kids')
                .query({
                    where: '{"age":{"gte":3}}',
                    sort: '-age',
                    limit: '1',
                    offset: '1',
                })
                .expect(200);

            // ASSERT
            expect(response.body).toMatchObject({
                total: 2,
                limit: 1,
                offset: 1,
            });
            expect(response.body.items).toEqual([three]);
        });

        test.each([
            ['broken where', { where: '{bad' }],
            ['limit that is not a number', { limit: 'abc' }],
            ['unknown parameter', { limt: '5' }],
            ['limit over the maximum, from the database', { limit: '501' }],
            ['unknown field, from the database', { where: '{"foo":1}' }],
        ])('answers 400 INVALID_QUERY for %s', async (name, query) => {
            const response = await request(app)
                .get('/api/kids')
                .query(query)
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_QUERY');
        });
    });

    describe('POST /api/kids', () => {
        test('answers 201 with the record and its Location', async () => {
            const response = await request(app)
                .post('/api/kids')
                .send(kid())
                .expect(201);

            expect(response.headers.location).toBe(
                `/api/kids/${response.body.id}`
            );
            // the defaults come from the database
            expect(response.body).toMatchObject({
                ...kid(),
                needsSpeechLessons: false,
                groupId: null,
            });
            await request(app).get(response.headers.location).expect(200);
        });

        test('lists every invalid field at once', async () => {
            const response = await request(app)
                .post('/api/kids')
                .send({ firstName: '', age: 99, sex: 'MALE', foo: 1 })
                .expect(422);

            expect(response.body.error.code).toBe('VALIDATION_ERROR');
            expect(
                response.body.error.details.map(({ field }) => field).sort()
            ).toEqual(['age', 'firstName', 'foo', 'lastName']);
        });

        test.each([
            ['an array', []],
            ['the id of the record', kid({ id: uuidv7() })],
        ])('answers 422 for %s', async (name, body) => {
            await request(app).post('/api/kids').send(body).expect(422);
        });

        test('answers 422 without a body', async () => {
            await request(app).post('/api/kids').expect(422);
        });

        test('stores nothing after an invalid request', async () => {
            await request(app)
                .post('/api/kids')
                .send(kid({ age: 99 }))
                .expect(422);

            expect((await repositories.kids.findPage()).total).toBe(0);
        });

        test.each([['groupId'], ['discountId'], ['motherId'], ['fatherId']])(
            'rejects a %s that is not a UUIDv7',
            async (field) => {
                const response = await request(app)
                    .post('/api/kids')
                    .send(kid({ [field]: uuidv4() }))
                    .expect(422);

                expect(response.body.error.code).toBe('VALIDATION_ERROR');
                expect(response.body.error.details[0].field).toBe(field);
            }
        );

        test('leaves a reference to a missing record to the database', async () => {
            const response = await request(app)
                .post('/api/kids')
                .send(kid({ motherId: uuidv7() }))
                .expect(422);

            expect(response.body.error.code).toBe('REFERENCE_NOT_FOUND');
        });

        test('answers the business errors of the service', async () => {
            // ARRANGE
            const father = await repositories.parents.create({
                firstName: 'Олена',
                lastName: 'Коваль',
                sex: 'FEMALE',
            });
            const group = await repositories.groups.create({
                name: 'Сонечко',
                age: 3,
            });
            for (let i = 0; i < MAX_GROUP_SIZE; i++) {
                await repositories.kids.create(kid({ groupId: group.id }));
            }

            // ACT
            const wrongFather = await request(app)
                .post('/api/kids')
                .send(kid({ fatherId: father.id }));
            const full = await request(app)
                .post('/api/kids')
                .send(kid({ groupId: group.id }));

            // ASSERT
            expect(wrongFather.status).toBe(422);
            expect(wrongFather.body.error.code).toBe('FATHER_NOT_MALE');
            expect(full.status).toBe(409);
            expect(full.body.error.code).toBe('GROUP_FULL');
        });
    });

    describe('GET /api/kids/:id', () => {
        test('answers the record', async () => {
            const created = await createKid();

            const response = await request(app)
                .get(`/api/kids/${created.id}`)
                .expect(200);

            expect(response.body).toEqual(created);
        });

        test('answers 404 for a missing kid', async () => {
            const response = await request(app)
                .get(`/api/kids/${uuidv7()}`)
                .expect(404);

            expect(response.body.error.code).toBe('NOT_FOUND');
        });
    });

    describe('PUT /api/kids/:id', () => {
        test('replaces the record: fields not given get their defaults', async () => {
            const { id } = await createKid({ needsSpeechLessons: true });

            const response = await request(app)
                .put(`/api/kids/${id}`)
                .send(kid({ firstName: 'Остап' }))
                .expect(200);

            expect(response.body).toMatchObject({
                id,
                firstName: 'Остап',
                needsSpeechLessons: false,
            });
        });

        test('requires all the required fields', async () => {
            const { id } = await createKid();

            await request(app)
                .put(`/api/kids/${id}`)
                .send({ firstName: 'Остап' })
                .expect(422);
        });
    });

    describe('PATCH /api/kids/:id', () => {
        test('changes only the given fields', async () => {
            // needsSpeechLessons has a default in the database: it must stay
            const { id } = await createKid({ needsSpeechLessons: true });

            const response = await request(app)
                .patch(`/api/kids/${id}`)
                .send({ firstName: 'Остап' })
                .expect(200);

            expect(response.body).toMatchObject({
                firstName: 'Остап',
                lastName: 'Коваль',
                needsSpeechLessons: true,
            });
        });

        test('rejects an invalid field', async () => {
            const { id } = await createKid();

            const response = await request(app)
                .patch(`/api/kids/${id}`)
                .send({ age: 99 })
                .expect(422);

            expect(response.body.error.details[0].field).toBe('age');
        });

        test('keeps a kid in their group when their age changes (BR-08)', async () => {
            const group = await repositories.groups.create({
                name: 'Сонечко',
                age: 3,
            });
            const { id } = await createKid({ groupId: group.id });

            const response = await request(app)
                .patch(`/api/kids/${id}`)
                .send({ age: 4 })
                .expect(200);

            expect(response.body).toMatchObject({ age: 4, groupId: group.id });
        });
    });

    describe('DELETE /api/kids/:id', () => {
        test('answers 204 without a body, with what is left without the kid (FR-018)', async () => {
            // ARRANGE
            const group = await repositories.groups.create({
                name: 'Сонечко',
                age: 3,
            });
            const mother = await repositories.parents.create({
                firstName: 'Олена',
                lastName: 'Коваль',
                sex: 'FEMALE',
            });
            const { id } = await createKid({
                groupId: group.id,
                motherId: mother.id,
            });
            await repositories.notes.create({ text: 'Алергія', kidId: id });

            // ACT
            const response = await request(app)
                .delete(`/api/kids/${id}`)
                .expect(204);

            // ASSERT
            expect(response.text).toBe('');
            await request(app).get(`/api/kids/${id}`).expect(404);
            expect(await repositories.groups.findById(group.id)).toBeNull();
            expect(await repositories.parents.findById(mother.id)).toBeNull();
            expect((await repositories.notes.findPage()).total).toBe(0);
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
                const spy = vi.spyOn(container.services.kids, serviceMethod);

                // ACT
                const client = request(app);
                const response = await client[method](`/api/kids/${id}`)
                    .send(method === 'put' ? kid() : undefined)
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
                .patch('/api/kids/abc')
                .send({ age: 99 })
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_ID');
        });
    });
});
