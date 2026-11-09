import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { MAX_ROOMS } from '../../src/services/room-service.js';
import { createTestApp } from '../helpers/test-app.js';

describe('/api/rooms', () => {
    let app;
    let container;
    let close;
    let repositories;

    beforeEach(async () => {
        ({ app, container, close } = await createTestApp());
        repositories = container.repositories;
    });

    afterEach(async () => close());

    const room = (fields = {}) => ({ name: 'Кімната 1', ...fields });
    const createRoom = async (fields) =>
        (await request(app).post('/api/rooms').send(room(fields)).expect(201))
            .body;
    const createSubject = (name) => repositories.subjects.create({ name });
    const createGroup = (name = 'Сонечко') =>
        repositories.groups.create({ name, age: 3 });

    describe('GET /api/rooms', () => {
        test('answers a page of rooms', async () => {
            const created = await createRoom();

            const response = await request(app).get('/api/rooms').expect(200);

            expect(response.body).toEqual({
                items: [created],
                total: 1,
                limit: 100,
                offset: 0,
            });
        });

        test('filters, sorts and pages by the query string', async () => {
            // ARRANGE
            const group = await createGroup();
            await createRoom({ name: 'Кімната 1', groupId: group.id });
            const two = await createRoom({ name: 'Кімната 2' });
            await createRoom({ name: 'Кімната 3' });

            // ACT
            const response = await request(app)
                .get('/api/rooms')
                .query({
                    where: '{"groupId":null}',
                    sort: 'name',
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
            expect(response.body.items).toEqual([two]);
        });

        test.each([
            ['broken where', { where: '{bad' }],
            ['limit that is not a number', { limit: 'abc' }],
            ['unknown parameter', { limt: '5' }],
            ['limit over the maximum, from the database', { limit: '501' }],
            ['unknown field, from the database', { where: '{"foo":1}' }],
        ])('answers 400 INVALID_QUERY for %s', async (name, query) => {
            const response = await request(app)
                .get('/api/rooms')
                .query(query)
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_QUERY');
        });
    });

    describe('POST /api/rooms', () => {
        test('answers 201 with the record and its Location', async () => {
            const response = await request(app)
                .post('/api/rooms')
                .send(room())
                .expect(201);

            expect(response.headers.location).toBe(
                `/api/rooms/${response.body.id}`
            );
            // the defaults come from the database
            expect(response.body).toMatchObject({
                ...room(),
                groupId: null,
                subjectIds: [],
            });
            await request(app).get(response.headers.location).expect(200);
        });

        test('stores a gym with two subjects', async () => {
            const gym = await createSubject('Фізкультура');
            const wrestling = await createSubject('Боротьба');

            const created = await createRoom({
                name: 'Спортзал',
                subjectIds: [gym.id, wrestling.id],
            });

            expect(created.subjectIds).toEqual([gym.id, wrestling.id]);
        });

        test('lists every invalid field at once', async () => {
            const response = await request(app)
                .post('/api/rooms')
                .send({ name: '', groupId: 'abc', subjectIds: ['abc'], foo: 1 })
                .expect(422);

            expect(response.body.error.code).toBe('VALIDATION_ERROR');
            expect(
                response.body.error.details.map(({ field }) => field).sort()
            ).toEqual(['foo', 'groupId', 'name', 'subjectIds.0']);
        });

        test('rejects the same subject twice', async () => {
            const gym = await createSubject('Фізкультура');

            const response = await request(app)
                .post('/api/rooms')
                .send(room({ subjectIds: [gym.id, gym.id] }))
                .expect(422);

            expect(response.body.error.details).toEqual([
                {
                    field: 'subjectIds',
                    message: 'Must not contain duplicates.',
                },
            ]);
        });

        test.each([
            ['groupId', { groupId: uuidv4() }, 'groupId'],
            ['a subject id', { subjectIds: [uuidv4()] }, 'subjectIds.0'],
        ])('rejects %s that is not a UUIDv7', async (name, fields, field) => {
            const response = await request(app)
                .post('/api/rooms')
                .send(room(fields))
                .expect(422);

            expect(response.body.error.details[0].field).toBe(field);
        });

        test.each([
            ['group', { groupId: uuidv7() }],
            ['subject', { subjectIds: [uuidv7()] }],
        ])(
            'leaves a reference to a missing %s to the database',
            async (name, fields) => {
                const response = await request(app)
                    .post('/api/rooms')
                    .send(room(fields))
                    .expect(422);

                expect(response.body.error.code).toBe('REFERENCE_NOT_FOUND');
            }
        );

        test('rejects a name that is already taken', async () => {
            await createRoom();

            const response = await request(app)
                .post('/api/rooms')
                .send(room())
                .expect(409);

            expect(response.body.error.code).toBe('UNIQUE_VIOLATION');
        });

        test('answers the business errors of the service', async () => {
            // ARRANGE
            const gym = await createSubject('Фізкультура');
            const group = await createGroup();
            for (let i = 0; i < MAX_ROOMS; i++) {
                await repositories.rooms.create({ name: `Room ${i}` });
            }

            // ACT
            const both = await request(app)
                .post('/api/rooms')
                .send(room({ groupId: group.id, subjectIds: [gym.id] }));
            const tooMany = await request(app).post('/api/rooms').send(room());

            // ASSERT
            expect(both.status).toBe(422);
            expect(both.body.error.code).toBe('ROOM_PURPOSE_CONFLICT');
            expect(tooMany.status).toBe(409);
            expect(tooMany.body.error.code).toBe('ROOM_LIMIT_REACHED');
        });

        test('rejects a second room for the same group', async () => {
            const group = await createGroup();
            await createRoom({ name: 'Кімната 1', groupId: group.id });

            const response = await request(app)
                .post('/api/rooms')
                .send(room({ name: 'Кімната 2', groupId: group.id }))
                .expect(409);

            expect(response.body.error.code).toBe('UNIQUE_VIOLATION');
        });

        test.each([
            ['an array', []],
            ['the id of the record', room({ id: uuidv7() })],
            ['subjectIds null', room({ subjectIds: null })],
        ])('answers 422 for %s', async (name, body) => {
            await request(app).post('/api/rooms').send(body).expect(422);
        });

        test('answers 422 without a body', async () => {
            await request(app).post('/api/rooms').expect(422);
        });

        test('stores nothing after an invalid request', async () => {
            await request(app)
                .post('/api/rooms')
                .send(room({ name: '' }))
                .expect(422);

            expect((await repositories.rooms.findPage()).total).toBe(0);
        });
    });

    describe('GET /api/rooms/:id', () => {
        test('answers the record', async () => {
            const created = await createRoom();

            const response = await request(app)
                .get(`/api/rooms/${created.id}`)
                .expect(200);

            expect(response.body).toEqual(created);
        });

        test('answers 404 for a missing room', async () => {
            const response = await request(app)
                .get(`/api/rooms/${uuidv7()}`)
                .expect(404);

            expect(response.body.error.code).toBe('NOT_FOUND');
        });
    });

    describe('PUT /api/rooms/:id', () => {
        test('replaces the record: fields not given get their defaults', async () => {
            const group = await createGroup();
            const { id } = await createRoom({ groupId: group.id });

            const response = await request(app)
                .put(`/api/rooms/${id}`)
                .send(room({ name: 'Кімната 9' }))
                .expect(200);

            expect(response.body).toEqual({
                id,
                name: 'Кімната 9',
                groupId: null,
                subjectIds: [],
            });
        });

        test('requires all the required fields', async () => {
            const { id } = await createRoom();

            await request(app).put(`/api/rooms/${id}`).send({}).expect(422);
        });

        test('answers 404 for a missing room', async () => {
            await request(app)
                .put(`/api/rooms/${uuidv7()}`)
                .send(room())
                .expect(404);
        });
    });

    describe('PATCH /api/rooms/:id', () => {
        test('assigns the room to a group and keeps the other fields', async () => {
            const group = await createGroup();
            const { id } = await createRoom();

            const response = await request(app)
                .patch(`/api/rooms/${id}`)
                .send({ groupId: group.id })
                .expect(200);

            expect(response.body).toEqual({
                id,
                name: 'Кімната 1',
                groupId: group.id,
                subjectIds: [],
            });
        });

        test('turns a room for classes into a room for a group at once', async () => {
            const gym = await createSubject('Фізкультура');
            const group = await createGroup();
            const { id } = await createRoom({ subjectIds: [gym.id] });

            const response = await request(app)
                .patch(`/api/rooms/${id}`)
                .send({ groupId: group.id, subjectIds: [] })
                .expect(200);

            expect(response.body).toMatchObject({
                groupId: group.id,
                subjectIds: [],
            });
        });

        test('rejects a group for a room with subjects (BR-14)', async () => {
            const gym = await createSubject('Фізкультура');
            const group = await createGroup();
            const { id } = await createRoom({ subjectIds: [gym.id] });

            const response = await request(app)
                .patch(`/api/rooms/${id}`)
                .send({ groupId: group.id })
                .expect(422);

            expect(response.body.error.code).toBe('ROOM_PURPOSE_CONFLICT');
        });

        test('frees the room of its group with null', async () => {
            const group = await createGroup();
            const { id } = await createRoom({ groupId: group.id });

            const response = await request(app)
                .patch(`/api/rooms/${id}`)
                .send({ groupId: null })
                .expect(200);

            expect(response.body.groupId).toBeNull();
        });

        test('rejects an invalid field', async () => {
            const { id } = await createRoom();

            const response = await request(app)
                .patch(`/api/rooms/${id}`)
                .send({ name: 'x'.repeat(26) })
                .expect(422);

            expect(response.body.error.details[0].field).toBe('name');
        });
    });

    describe('DELETE /api/rooms/:id', () => {
        test('answers 204 without a body', async () => {
            const { id } = await createRoom();

            const response = await request(app)
                .delete(`/api/rooms/${id}`)
                .expect(204);

            expect(response.text).toBe('');
            await request(app).get(`/api/rooms/${id}`).expect(404);
        });

        test('answers 404 for a missing room', async () => {
            await request(app).delete(`/api/rooms/${uuidv7()}`).expect(404);
        });
    });

    describe('deleting what a room refers to', () => {
        test('a deleted group leaves its room free', async () => {
            const group = await createGroup();
            const { id } = await createRoom({ groupId: group.id });

            await request(app).delete(`/api/groups/${group.id}`).expect(204);

            const response = await request(app)
                .get(`/api/rooms/${id}`)
                .expect(200);
            expect(response.body.groupId).toBeNull();
        });

        test('a deleted subject is removed from the room', async () => {
            const gym = await createSubject('Фізкультура');
            const wrestling = await createSubject('Боротьба');
            const { id } = await createRoom({
                subjectIds: [gym.id, wrestling.id],
            });

            await request(app).delete(`/api/subjects/${gym.id}`).expect(204);

            const response = await request(app)
                .get(`/api/rooms/${id}`)
                .expect(200);
            expect(response.body.subjectIds).toEqual([wrestling.id]);
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
                const spy = vi.spyOn(container.services.rooms, serviceMethod);

                // ACT
                const client = request(app);
                const response = await client[method](`/api/rooms/${id}`)
                    .send(method === 'put' ? room() : undefined)
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
                .patch('/api/rooms/abc')
                .send({ name: '' })
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_ID');
        });
    });
});
