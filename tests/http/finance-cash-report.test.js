import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';
import { createReadyGroup } from '../helpers/ready-group.js';
import { monthAt, monthMoments } from '../../src/services/months.js';

/** The month after one, `YYYY-MM`. */
const nextMonth = (period) => monthAt(new Date(monthMoments(period).to));

describe('GET /api/finance/report?basis=CASH (TS-06.3, FR-017)', () => {
    let app;
    let repositories;
    let close;
    let group;
    // payments are made now, so they are income of this month in Kyiv
    const thisMonth = monthAt();

    beforeEach(async () => {
        let container;
        ({ app, container, close } = await createTestApp());
        repositories = container.repositories;
        group = await createReadyGroup(repositories, { age: 3 });
    });

    afterEach(async () => close());

    const createKid = (fields = {}) =>
        repositories.kids.create({
            firstName: 'Marko',
            lastName: 'Koval',
            age: 3,
            sex: 'MALE',
            groupId: group.id,
            ...fields,
        });
    /** Issues the invoices of a kid for this month and pays them. */
    const issueAndPay = async (kid) => {
        const { body } = await request(app)
            .post('/api/invoices')
            .send({ kidId: kid.id, period: thisMonth })
            .expect(201);
        await request(app)
            .post('/api/payments')
            .send({ invoiceIds: body.items.map((i) => i.id), method: 'CARD' })
            .expect(201);
        return body.items;
    };
    const report = (query) =>
        request(app).get('/api/finance/report').query(query).expect(200);

    test('a year paid in advance is income of the month it was paid in, not of each month', async () => {
        // ARRANGE
        const kid = await createKid({ paymentPlan: 'ANNUAL' });
        await issueAndPay(kid);

        // ACT
        const cash = await report({ basis: 'CASH', month: thisMonth });
        const later = await report({
            basis: 'CASH',
            month: nextMonth(thisMonth),
        });
        const accrual = await report();

        // ASSERT
        // 15 000 × 0.88 × 12 and 400 × 22
        expect(cash.body.groups[0].income).toEqual({
            tuition: 158400,
            meals: 8800,
            total: 167200,
        });
        expect(later.body.groups[0].income.total).toBe(0);
        // by accrual a twelfth of it each month
        expect(accrual.body.groups[0].income.tuition).toBe(13200);
    });

    test('an invoice not paid is not income', async () => {
        const kid = await createKid();
        await request(app)
            .post('/api/invoices')
            .send({ kidId: kid.id, period: thisMonth })
            .expect(201);

        const { body } = await report({ basis: 'CASH', month: thisMonth });

        expect(body.total.income).toBe(0);
    });

    test('says the method and the time; the expenses are those of accrual', async () => {
        await issueAndPay(await createKid());

        const cash = await report({ basis: 'CASH', month: '2026-11' });
        const accrual = await report();

        expect(cash.body).toMatchObject({
            basis: 'CASH',
            month: '2026-11',
            from: '2026-11-01T00:00:00+02:00',
            to: '2026-12-01T00:00:00+02:00',
            expensesBasis: 'ACCRUAL',
        });
        expect(Date.parse(cash.body.asOf)).not.toBeNaN();
        expect(cash.body.shared).toEqual(accrual.body.shared);
        expect(cash.body.groups[0].expenses).toEqual(
            accrual.body.groups[0].expenses
        );
        expect(cash.body.total.expenses).toBe(accrual.body.total.expenses);
        expect(cash.body.total.profit).toBe(
            Math.round(
                (cash.body.total.income - cash.body.total.expenses) * 100
            ) / 100
        );
    });

    test('money of a group deleted since is income without a group', async () => {
        const kid = await createKid();
        await issueAndPay(kid);
        await request(app).delete(`/api/groups/${group.id}`).expect(204);

        const { body } = await report({ basis: 'CASH', month: thisMonth });

        expect(body.groups).toEqual([]);
        expect(body.withoutGroup).toEqual({
            tuition: 15000,
            meals: 8800,
            total: 23800,
        });
        expect(body.total.income).toBe(23800);
    });

    test('the report by accrual stays the default, without a month', async () => {
        const { body } = await report();

        expect(body.basis).toBe('ACCRUAL');
        expect(body).not.toHaveProperty('month');
    });

    test.each([
        ['CASH without a month', { basis: 'CASH' }],
        ['a month without CASH', { month: '2026-11' }],
        ['ACCRUAL with a month', { basis: 'ACCRUAL', month: '2026-11' }],
        ['a month that is not one', { basis: 'CASH', month: '2026-13' }],
        ['an unknown method', { basis: 'PAYMENTS' }],
    ])('answers 400 INVALID_QUERY for %s', async (name, query) => {
        const response = await request(app)
            .get('/api/finance/report')
            .query(query)
            .expect(400);

        expect(response.body.error.code).toBe('INVALID_QUERY');
    });
});
