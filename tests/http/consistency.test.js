import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';

describe('/api/consistency (FR-019)', () => {
    let app;
    let close;
    let repositories;

    beforeEach(async () => {
        let container;
        ({ app, container, close } = await createTestApp());
        repositories = container.repositories;
    });

    afterEach(async () => close());

    const groupless = () =>
        repositories.kids.create({
            firstName: 'Марко',
            lastName: 'Коваль',
            age: 3,
            sex: 'MALE',
        });

    test('GET /api/consistency answers an empty summary for empty data', async () => {
        const response = await request(app).get('/api/consistency').expect(200);

        expect(response.body).toEqual({ problems: [] });
    });

    test('the link of a problem in the summary leads to its records', async () => {
        const kid = await groupless();
        const summary = await request(app).get('/api/consistency').expect(200);
        const { href } = summary.body.problems.find(
            ({ code }) => code === 'KID_WITHOUT_GROUP'
        );

        const response = await request(app).get(href).expect(200);

        expect(response.body.items.map(({ id }) => id)).toEqual([kid.id]);
        expect(response.body.items[0].problems).toContain('KID_WITHOUT_GROUP');
    });

    test.each([['kids'], ['groups'], ['educators'], ['assistants']])(
        'GET /api/consistency/%s answers a page',
        async (entity) => {
            const response = await request(app)
                .get(`/api/consistency/${entity}`)
                .expect(200);

            expect(response.body).toEqual({
                items: [],
                total: 0,
                limit: 100,
                offset: 0,
            });
        }
    );

    test('takes limit and offset', async () => {
        await groupless();
        await groupless();

        const response = await request(app)
            .get('/api/consistency/kids')
            .query({ limit: '1', offset: '1' })
            .expect(200);

        expect(response.body).toMatchObject({ total: 2, limit: 1, offset: 1 });
        expect(response.body.items).toHaveLength(1);
    });

    test.each([
        ['a problem of another entity', { problem: 'GROUP_WITHOUT_ROOM' }],
        ['an unknown problem', { problem: 'KID_TOO_LOUD' }],
        ['an unknown parameter', { where: '{}' }],
        ['limit 0', { limit: '0' }],
        ['limit over 500', { limit: '501' }],
        ['a negative offset', { offset: '-1' }],
    ])('answers 400 INVALID_QUERY for %s', async (name, query) => {
        const response = await request(app)
            .get('/api/consistency/kids')
            .query(query)
            .expect(400);

        expect(response.body.error.code).toBe('INVALID_QUERY');
    });

    test('answers 404 for an entity without diagnostics', async () => {
        const response = await request(app)
            .get('/api/consistency/rooms')
            .expect(404);

        expect(response.body.error.code).toBe('NOT_FOUND');
    });
});
