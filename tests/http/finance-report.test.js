import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';
import { createReadyGroup } from '../helpers/ready-group.js';

describe('GET /api/finance/report (FR-017)', () => {
    let app;
    let rawApp;
    let signIn;
    let repositories;
    let services;
    let close;

    beforeEach(async () => {
        let container;
        ({ app, rawApp, signIn, container, close } = await createTestApp());
        ({ repositories, services } = container);
    });

    afterEach(async () => {
        vi.useRealTimers();
        await close();
    });

    const createKid = (fields) =>
        repositories.kids.create({
            firstName: 'Marko',
            lastName: 'Koval',
            age: 3,
            sex: 'MALE',
            ...fields,
        });

    test('counts the kindergarten as it is now', async () => {
        // ARRANGE: a ready group of 3 with two kids, one more kid without a
        // group, a teacher and a manager
        const group = await createReadyGroup(repositories, { age: 3 });
        const discount = await repositories.discounts.create({
            name: 'Large family',
            rate: 0.2,
        });
        await createKid({ groupId: group.id });
        await createKid({
            groupId: group.id,
            discountId: discount.id,
            paymentPlan: 'ANNUAL',
        });
        await createKid({});
        await repositories.teachers.create({
            firstName: 'Petro',
            lastName: 'Shevchuk',
        });
        await signIn({ role: 'MANAGER' });

        // ACT
        const { body } = await request(app)
            .get('/api/finance/report')
            .expect(200);

        // ASSERT
        expect(body.basis).toBe('ACCRUAL');
        expect(body.amountsPer).toBe('MONTH');
        expect(body.groups).toEqual([
            {
                groupId: group.id,
                name: group.name,
                age: 3,
                // the kid without a group does not attend
                kids: 2,
                // 15 000 + 10 560 (a twelfth of 126 720)
                income: { tuition: 25560, meals: 17600, total: 43160 },
                // the rent of a room is 50 000 by default
                expenses: {
                    meals: 17600,
                    educator: 4000,
                    assistant: 20000,
                    room: 50000,
                    total: 91600,
                },
                profit: -48440,
            },
        ]);
        expect(body.shared).toEqual({
            managers: { count: 1, amount: 80000 },
            teachers: { count: 1, amount: 40000 },
            assistantsWithoutGroup: { count: 0, amount: 0 },
            classRooms: { count: 0, amount: 0 },
            total: 120000,
        });
        expect(body.total).toEqual({
            income: 43160,
            expenses: 211600,
            profit: -168440,
        });
    });

    test('follows the settings at once', async () => {
        const group = await createReadyGroup(repositories, { age: 3 });
        await createKid({ groupId: group.id });
        await request(app)
            .patch('/api/finance/settings')
            .send({ roomCostPerMonth: 3000, tuitionPerMonth: 20000 })
            .expect(200);

        const { body } = await request(app)
            .get('/api/finance/report')
            .expect(200);

        expect(body.groups[0].income.tuition).toBe(20000);
        expect(body.groups[0].expenses.room).toBe(3000);
    });

    test('an assistant without a group is still paid the base', async () => {
        await repositories.assistants.create({
            firstName: 'Oksana',
            lastName: 'Boiko',
        });

        const { body } = await request(app)
            .get('/api/finance/report')
            .expect(200);

        expect(body.shared.assistantsWithoutGroup).toEqual({
            count: 1,
            amount: 20000,
        });
    });

    test('says when it was counted', async () => {
        vi.useFakeTimers({
            now: new Date('2026-11-20T12:00:00Z'),
            toFake: ['Date'],
        });

        // through the service: the token of the test is from the real clock
        const body = await services.finance.report();

        expect(body.asOf).toBe('2026-11-20T12:00:00.000Z');
    });

    test.each([
        ['month', '2026-11'],
        ['from', '2026-01-01'],
    ])(
        'answers 400 INVALID_QUERY for ?%s: there are no past states',
        async (name, value) => {
            const response = await request(app)
                .get('/api/finance/report')
                .query({ [name]: value })
                .expect(400);

            expect(response.body.error.code).toBe('INVALID_QUERY');
        }
    );

    test('is for the admin only', async () => {
        const { auth } = await signIn({ role: 'MANAGER' });

        await request(rawApp).get('/api/finance/report').set(auth).expect(403);
    });

    test('changes nothing', async () => {
        await request(app).get('/api/finance/settings');
        const before = await repositories.kids.findPage();

        await request(app).get('/api/finance/report').expect(200);

        expect(await repositories.kids.findPage()).toEqual(before);
    });
});
