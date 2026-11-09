import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { createTestApp } from '../helpers/test-app.js';

describe('/api/discounts', () => {
    let app;
    let container;
    let close;
    let repositories;

    beforeEach(async () => {
        ({ app, container, close } = await createTestApp());
        repositories = container.repositories;
    });

    afterEach(async () => close());

    const discount = (fields = {}) => ({
        name: 'Пільга 10%',
        rate: 0.1,
        ...fields,
    });
    const createDiscount = async (fields) =>
        (
            await request(app)
                .post('/api/discounts')
                .send(discount(fields))
                .expect(201)
        ).body;

    describe('GET /api/discounts', () => {
        test('answers a page of discounts', async () => {
            const created = await createDiscount();

            const response = await request(app)
                .get('/api/discounts')
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
            await createDiscount({ name: 'Багатодітні', rate: 0.1 });
            const twenty = await createDiscount({
                name: 'Учасники',
                rate: 0.2,
            });
            await createDiscount({ name: 'Інвалідність', rate: 0.3 });

            // ACT
            const response = await request(app)
                .get('/api/discounts')
                .query({
                    where: '{"rate":{"gte":0.2}}',
                    sort: 'rate',
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
            expect(response.body.items).toEqual([twenty]);
        });

        test.each([
            ['broken where', { where: '{bad' }],
            ['limit that is not a number', { limit: 'abc' }],
            ['unknown parameter', { limt: '5' }],
            ['limit over the maximum, from the database', { limit: '501' }],
            ['unknown field, from the database', { where: '{"foo":1}' }],
        ])('answers 400 INVALID_QUERY for %s', async (name, query) => {
            const response = await request(app)
                .get('/api/discounts')
                .query(query)
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_QUERY');
        });
    });

    describe('POST /api/discounts', () => {
        test('answers 201 with the record and its Location', async () => {
            const response = await request(app)
                .post('/api/discounts')
                .send(discount())
                .expect(201);

            expect(response.headers.location).toBe(
                `/api/discounts/${response.body.id}`
            );
            expect(response.body).toMatchObject(discount());
            await request(app).get(response.headers.location).expect(200);
        });

        test('lists every invalid field at once', async () => {
            const response = await request(app)
                .post('/api/discounts')
                .send({ name: '', rate: 1.5, foo: 1 })
                .expect(422);

            expect(response.body.error.code).toBe('VALIDATION_ERROR');
            expect(
                response.body.error.details.map(({ field }) => field).sort()
            ).toEqual(['foo', 'name', 'rate']);
        });

        test.each([[0], [0.15], [1]])(
            'accepts the rate %s: the administrator chooses any share',
            async (rate) => {
                const response = await request(app)
                    .post('/api/discounts')
                    .send(discount({ rate }))
                    .expect(201);

                expect(response.body.rate).toBe(rate);
            }
        );

        test.each([[-0.1], [1.5], [10]])(
            'rejects the rate %s, which is not from 0 to 1',
            async (rate) => {
                const response = await request(app)
                    .post('/api/discounts')
                    .send(discount({ rate }))
                    .expect(422);

                expect(response.body.error.details[0].field).toBe('rate');
            }
        );

        test.each([
            ['an array', []],
            ['the id of the record', discount({ id: uuidv7() })],
        ])('answers 422 for %s', async (name, body) => {
            await request(app).post('/api/discounts').send(body).expect(422);
        });

        test('answers 422 without a body', async () => {
            await request(app).post('/api/discounts').expect(422);
        });

        test('stores nothing after an invalid request', async () => {
            await request(app)
                .post('/api/discounts')
                .send(discount({ rate: 1.5 }))
                .expect(422);

            expect((await repositories.discounts.findPage()).total).toBe(0);
        });

        test('rejects a name that is already taken', async () => {
            await createDiscount();

            const response = await request(app)
                .post('/api/discounts')
                .send(discount({ rate: 0.2 }))
                .expect(409);

            expect(response.body.error.code).toBe('UNIQUE_VIOLATION');
        });
    });

    describe('GET /api/discounts/:id', () => {
        test('answers the record', async () => {
            const created = await createDiscount();

            const response = await request(app)
                .get(`/api/discounts/${created.id}`)
                .expect(200);

            expect(response.body).toEqual(created);
        });

        test('answers 404 for a missing discount', async () => {
            const response = await request(app)
                .get(`/api/discounts/${uuidv7()}`)
                .expect(404);

            expect(response.body.error.code).toBe('NOT_FOUND');
        });
    });

    describe('PUT /api/discounts/:id', () => {
        test('replaces the record', async () => {
            const { id } = await createDiscount();

            const response = await request(app)
                .put(`/api/discounts/${id}`)
                .send({ name: 'Пільга 30%', rate: 0.3 })
                .expect(200);

            expect(response.body).toEqual({
                id,
                name: 'Пільга 30%',
                rate: 0.3,
            });
        });

        test('requires all the required fields', async () => {
            const { id } = await createDiscount();

            await request(app)
                .put(`/api/discounts/${id}`)
                .send({ rate: 0.3 })
                .expect(422);
        });

        test('answers 404 for a missing discount', async () => {
            await request(app)
                .put(`/api/discounts/${uuidv7()}`)
                .send(discount())
                .expect(404);
        });
    });

    describe('PATCH /api/discounts/:id', () => {
        test('changes only the given fields', async () => {
            const { id } = await createDiscount();

            const response = await request(app)
                .patch(`/api/discounts/${id}`)
                .send({ rate: 0.2 })
                .expect(200);

            expect(response.body).toEqual({
                id,
                name: 'Пільга 10%',
                rate: 0.2,
            });
        });

        test('rejects a rate over 1', async () => {
            const { id } = await createDiscount();

            const response = await request(app)
                .patch(`/api/discounts/${id}`)
                .send({ rate: 1.5 })
                .expect(422);

            expect(response.body.error.details[0].field).toBe('rate');
        });
    });

    describe('DELETE /api/discounts/:id', () => {
        test('answers 204 without a body', async () => {
            const { id } = await createDiscount();

            const response = await request(app)
                .delete(`/api/discounts/${id}`)
                .expect(204);

            expect(response.text).toBe('');
            await request(app).get(`/api/discounts/${id}`).expect(404);
        });

        test('leaves the kids who had it without a discount', async () => {
            // ARRANGE
            const { id } = await createDiscount();
            const kid = await repositories.kids.create({
                firstName: 'Марко',
                lastName: 'Коваль',
                age: 3,
                sex: 'MALE',
                discountId: id,
            });

            // ACT
            await request(app).delete(`/api/discounts/${id}`).expect(204);

            // ASSERT
            expect(await repositories.kids.getById(kid.id)).toMatchObject({
                discountId: null,
            });
        });

        test('answers 404 for a missing discount', async () => {
            await request(app).delete(`/api/discounts/${uuidv7()}`).expect(404);
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
                    container.services.discounts,
                    serviceMethod
                );

                // ACT
                const client = request(app);
                const response = await client[method](`/api/discounts/${id}`)
                    .send(method === 'put' ? discount() : undefined)
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
                .patch('/api/discounts/abc')
                .send({ rate: 1.5 })
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_ID');
        });
    });
});
