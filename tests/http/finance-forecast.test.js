import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';

describe('POST /api/finance/forecast (2.1)', () => {
    let app;
    let rawApp;
    let signIn;
    let repositories;
    let close;

    beforeEach(async () => {
        let container;
        ({ app, rawApp, signIn, container, close } = await createTestApp());
        repositories = container.repositories;
    });

    afterEach(async () => close());

    const forecast = (body) =>
        request(app).post('/api/finance/forecast').send(body);

    test('20 kids of 3 make one full group, line by line', async () => {
        const { body } = await forecast({ kids: { 3: 20 } }).expect(200);

        expect(body.groups).toEqual([
            {
                groupId: null,
                name: 'Age 3, group 1',
                age: 3,
                kids: 20,
                // 20 × 15 000; 20 × 400 × 22
                income: { tuition: 300000, meals: 176000, total: 476000 },
                expenses: {
                    meals: 176000,
                    // 20 × 2 000 + 8 × 5 000
                    educator: 80000,
                    // 20 000 + 8 × 3 000
                    assistant: 44000,
                    room: 50000,
                    total: 350000,
                },
                profit: 126000,
            },
        ]);
    });

    test('40 kids of 3: three groups earn more than two full ones', async () => {
        const { body } = await forecast({ kids: { 3: 40 } }).expect(200);

        // 14 + 13 + 13: 96 000 + 91 000 + 91 000, against 2 × 126 000
        expect(body.groups.map((group) => group.kids)).toEqual([14, 13, 13]);
        expect(body.total.profit).toBe(278000);
        expect(body.fewestGroups).toEqual({
            groups: 2,
            total: { income: 952000, expenses: 700000, profit: 252000 },
        });
    });

    test('keeps what belongs to no group as it is now, and shows now to compare', async () => {
        // ARRANGE: a manager and two teachers, no kids yet
        await signIn({ role: 'MANAGER' });
        for (const firstName of ['Petro', 'Anna']) {
            await repositories.teachers.create({ firstName, lastName: 'Lys' });
        }

        // ACT
        const { body } = await forecast({ kids: { 3: 40 } }).expect(200);

        // ASSERT: 80 000 + 2 × 40 000
        expect(body.shared.total).toBe(160000);
        expect(body.total.profit).toBe(278000 - 160000);
        expect(body.fewestGroups.total.profit).toBe(252000 - 160000);
        expect(body.now).toEqual({
            income: 0,
            expenses: 160000,
            profit: -160000,
        });
    });

    test('the average discount and the annual share', async () => {
        const { body } = await forecast({
            kids: { 3: 20 },
            averageDiscount: 0.1,
            annualShare: 0.5,
        }).expect(200);

        // 10 kids monthly: 15 000 − 10% = 13 500;
        // 10 kids annual: 13 500 − 12% = 11 880
        expect(body.groups[0].income.tuition).toBe(10 * 13500 + 10 * 11880);
        expect(body.assumptions).toEqual({
            kids: { 3: 20 },
            averageDiscount: 0.1,
            annualShare: 0.5,
        });
    });

    test('uses the current prices', async () => {
        await request(app)
            .patch('/api/finance/settings')
            .send({ tuitionPerMonth: 20000 })
            .expect(200);

        const { body } = await forecast({ kids: { 2: 1 } }).expect(200);

        expect(body.groups[0].income.tuition).toBe(20000);
    });

    test('answers 422 TOO_MANY_GROUPS past 15 groups (BR-19)', async () => {
        // 300 kids of 2 fill 15 groups; one kid of 3 needs a 16th
        const response = await forecast({ kids: { 2: 300, 3: 1 } }).expect(422);

        expect(response.body.error).toEqual({
            code: 'TOO_MANY_GROUPS',
            message:
                'These kids need 16 groups of at most 20; the kindergarten can have at most 15 (BR-19).',
        });
    });

    test('15 full groups fit', async () => {
        const { body } = await forecast({ kids: { 5: 300 } }).expect(200);

        expect(body.groups).toHaveLength(15);
    });

    test.each([
        ['no kids', {}],
        ['an age the kindergarten does not take (BR-01)', { kids: { 6: 5 } }],
        ['a negative number', { kids: { 3: -1 } }],
        ['a fraction of a kid', { kids: { 3: 1.5 } }],
        ['a discount over 1', { kids: { 3: 5 }, averageDiscount: 1.2 }],
        ['an unknown field', { kids: { 3: 5 }, months: 12 }],
    ])('answers 422 VALIDATION_ERROR for %s', async (name, body) => {
        const response = await forecast(body).expect(422);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('stores nothing', async () => {
        await forecast({ kids: { 3: 40 } }).expect(200);

        expect((await repositories.groups.findPage()).total).toBe(0);
        expect((await repositories.kids.findPage()).total).toBe(0);
    });

    test('is for the admin only', async () => {
        const { auth } = await signIn({ role: 'MANAGER' });

        await request(rawApp)
            .post('/api/finance/forecast')
            .set(auth)
            .send({ kids: { 3: 1 } })
            .expect(403);
    });
});
