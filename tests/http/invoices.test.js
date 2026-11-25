import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { createTestApp } from '../helpers/test-app.js';
import { createReadyGroup } from '../helpers/ready-group.js';

describe('invoices (TS-06.1, FR-014)', () => {
    let app;
    let rawApp;
    let signIn;
    let repositories;
    let close;
    let group;

    beforeEach(async () => {
        let container;
        ({ app, rawApp, signIn, container, close } = await createTestApp());
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
    const issue = (kidId, period = '2026-11') =>
        request(app).post('/api/invoices').send({ kidId, period });

    describe('POST /api/invoices', () => {
        test('a month of a kid on the monthly plan: one invoice with tuition and meals', async () => {
            // ARRANGE
            const kid = await createKid();

            // ACT
            const { body } = await issue(kid.id).expect(201);

            // ASSERT
            expect(body.items).toEqual([
                {
                    id: expect.any(String),
                    kidId: kid.id,
                    kidName: 'Marko Koval',
                    groupId: group.id,
                    kind: 'MONTHLY',
                    periodStart: '2026-11-01',
                    periodEnd: '2026-11-30',
                    lines: [
                        { type: 'TUITION', months: 1, amount: 15000 },
                        {
                            type: 'MEALS',
                            pricePerDay: 400,
                            days: 22,
                            amount: 8800,
                        },
                    ],
                    total: 23800,
                    status: 'UNPAID',
                    paymentId: null,
                    paidAt: null,
                    createdAt: expect.any(String),
                    updatedAt: expect.any(String),
                },
            ]);
        });

        test('the total is what GET /api/kids/:id/price says', async () => {
            const discount = await repositories.discounts.create({
                name: 'Large family',
                rate: 0.2,
            });
            const kid = await createKid({ age: 4, discountId: discount.id });

            const { body } = await issue(kid.id).expect(201);
            const price = await request(app)
                .get(`/api/kids/${kid.id}/price`)
                .expect(200);

            expect(body.items[0].total).toBe(price.body.payments.monthly);
            expect(body.items[0].lines[1]).toEqual({
                type: 'DISCOUNT',
                name: 'Large family',
                rate: 0.2,
                amount: -3000,
            });
        });

        test('the annual plan: the tuition of 12 months, and the meals of the month (FR-013, BR-32)', async () => {
            const kid = await createKid({ paymentPlan: 'ANNUAL' });

            const { body } = await issue(kid.id, '2026-11').expect(201);

            const [annual, monthly] = body.items;
            expect(annual).toMatchObject({
                kind: 'ANNUAL',
                periodStart: '2026-11-01',
                periodEnd: '2027-10-31',
                // 15 000 × 0.88 × 12
                total: 158400,
            });
            expect(monthly).toMatchObject({
                kind: 'MONTHLY',
                lines: [{ type: 'MEALS', amount: 8800 }],
                total: 8800,
            });
        });

        test('within the paid year only the meals are invoiced', async () => {
            const kid = await createKid({ paymentPlan: 'ANNUAL' });
            await issue(kid.id, '2026-11').expect(201);

            const { body } = await issue(kid.id, '2027-10').expect(201);

            expect(body.items).toHaveLength(1);
            expect(body.items[0]).toMatchObject({
                kind: 'MONTHLY',
                total: 8800,
            });
        });

        test('after the paid year a new annual invoice begins', async () => {
            const kid = await createKid({ paymentPlan: 'ANNUAL' });
            await issue(kid.id, '2026-11').expect(201);

            const { body } = await issue(kid.id, '2027-11').expect(201);

            expect(body.items.map((i) => i.kind)).toEqual([
                'ANNUAL',
                'MONTHLY',
            ]);
            expect(body.items[0].periodEnd).toBe('2028-10-31');
        });

        test('a kid moved to the monthly plan within a paid year pays no tuition twice', async () => {
            const kid = await createKid({ paymentPlan: 'ANNUAL' });
            await issue(kid.id, '2026-11').expect(201);
            await repositories.kids.update(kid.id, { paymentPlan: 'MONTHLY' });

            const { body } = await issue(kid.id, '2026-12').expect(201);

            expect(body.items[0].lines.map((l) => l.type)).toEqual(['MEALS']);
        });

        test('a month already invoiced: 409 INVOICE_EXISTS, nothing added', async () => {
            const kid = await createKid({ paymentPlan: 'ANNUAL' });
            await issue(kid.id).expect(201);

            const response = await issue(kid.id).expect(409);

            expect(response.body.error.code).toBe('INVOICE_EXISTS');
            expect((await repositories.invoices.findPage()).total).toBe(2);
        });

        test('new prices do not change an invoice already issued', async () => {
            const kid = await createKid();
            const { body } = await issue(kid.id).expect(201);
            await request(app)
                .patch('/api/finance/settings')
                .send({ tuitionPerMonth: 20000, mealPriceAge3: 500 })
                .expect(200);

            const invoice = await request(app)
                .get(`/api/invoices/${body.items[0].id}`)
                .expect(200);
            const next = await issue(kid.id, '2026-12').expect(201);

            expect(invoice.body.total).toBe(23800);
            // 20 000 + 500 × 22
            expect(next.body.items[0].total).toBe(31000);
        });

        test('a kid without a group is not invoiced: 422 KID_NOT_ENROLLED', async () => {
            const kid = await createKid({ groupId: null });

            const response = await issue(kid.id).expect(422);

            expect(response.body.error.code).toBe('KID_NOT_ENROLLED');
        });

        test('answers 404 for a missing kid', async () => {
            await issue(uuidv7()).expect(404);
        });

        test.each([['2026-13'], ['2026-1'], ['26-11'], ['2026-11-01']])(
            'answers 422 for the period "%s"',
            async (period) => {
                const kid = await createKid();

                const response = await issue(kid.id, period).expect(422);

                expect(response.body.error.details).toEqual([
                    { field: 'period', message: 'Must be a month: YYYY-MM.' },
                ]);
            }
        );
    });

    describe('POST /api/invoices/batch', () => {
        test('invoices every kid in a group, and not a kid without one', async () => {
            const marko = await createKid();
            const olia = await createKid({
                firstName: 'Olia',
                paymentPlan: 'ANNUAL',
            });
            await createKid({ firstName: 'Taras', groupId: null });

            const { body } = await request(app)
                .post('/api/invoices/batch')
                .send({ period: '2026-11' })
                .expect(201);

            expect(body.skipped).toBe(0);
            expect(body.items.map((i) => [i.kidName, i.kind]).sort()).toEqual([
                ['Marko Koval', 'MONTHLY'],
                ['Olia Koval', 'ANNUAL'],
                ['Olia Koval', 'MONTHLY'],
            ]);
            expect(new Set(body.items.map((i) => i.kidId))).toEqual(
                new Set([marko.id, olia.id])
            );
        });

        test('may be repeated: kids invoiced already are skipped', async () => {
            await createKid();
            const send = () =>
                request(app)
                    .post('/api/invoices/batch')
                    .send({ period: '2026-11' });
            await send().expect(201);
            const late = await createKid({ firstName: 'Olia' });

            const { body } = await send().expect(201);
            const again = await send().expect(200);

            expect(body.items.map((i) => i.kidId)).toEqual([late.id]);
            expect(body.skipped).toBe(1);
            expect(again.body).toEqual({ items: [], skipped: 2 });
        });
    });

    describe('GET /api/invoices', () => {
        test('filters by kid and period, sorts', async () => {
            const kid = await createKid();
            const other = await createKid({ firstName: 'Olia' });
            await issue(kid.id, '2026-11').expect(201);
            await issue(kid.id, '2026-12').expect(201);
            await issue(other.id, '2026-11').expect(201);

            const { body } = await request(app)
                .get('/api/invoices')
                .query({
                    where: JSON.stringify({ kidId: kid.id }),
                    sort: '-periodStart',
                })
                .expect(200);
            const unpaid = await request(app)
                .get('/api/invoices')
                .query({
                    where: '{"status":"UNPAID","periodStart":"2026-11-01"}',
                })
                .expect(200);

            expect(body.items.map((i) => i.periodStart)).toEqual([
                '2026-12-01',
                '2026-11-01',
            ]);
            expect(unpaid.body.total).toBe(2);
        });

        test('answers 404 for a missing invoice', async () => {
            await request(app).get(`/api/invoices/${uuidv7()}`).expect(404);
        });
    });

    describe('the parents (2.6, NFR-04)', () => {
        let own;
        let other;
        let mom;

        beforeEach(async () => {
            const parent = await repositories.parents.create({
                firstName: 'Olena',
                lastName: 'Koval',
                sex: 'FEMALE',
            });
            own = await createKid({ motherId: parent.id });
            const kid = await createKid({ firstName: 'Olia' });
            await issue(own.id).expect(201);
            ({
                body: {
                    items: [other],
                },
            } = await issue(kid.id).expect(201));
            mom = await signIn({ role: 'PARENT', parentId: parent.id });
        });

        test('see only the invoices of their kids', async () => {
            const { body } = await request(rawApp)
                .get('/api/invoices')
                .set(mom.auth)
                .expect(200);

            expect(body.items.map((i) => i.kidId)).toEqual([own.id]);
        });

        test('cannot widen the list by a filter of their own', async () => {
            const { body } = await request(rawApp)
                .get('/api/invoices')
                .query({ where: JSON.stringify({ kidId: other.kidId }) })
                .set(mom.auth)
                .expect(200);

            expect(body.items.map((i) => i.kidId)).toEqual([own.id]);
        });

        test('another kid’s invoice: 403', async () => {
            await request(rawApp)
                .get(`/api/invoices/${other.id}`)
                .set(mom.auth)
                .expect(403);
        });

        test('cannot issue or delete invoices', async () => {
            await request(rawApp)
                .post('/api/invoices')
                .set(mom.auth)
                .send({ kidId: own.id, period: '2026-12' })
                .expect(403);
            await request(rawApp)
                .delete(`/api/invoices/${other.id}`)
                .set(mom.auth)
                .expect(403);
        });
    });

    describe('DELETE /api/invoices/:id', () => {
        test('deletes an unpaid invoice, so the month can be issued again', async () => {
            const kid = await createKid();
            const { body } = await issue(kid.id).expect(201);

            await request(app)
                .delete(`/api/invoices/${body.items[0].id}`)
                .expect(204);

            await issue(kid.id).expect(201);
        });

        test('a paid invoice stays: 409 INVOICE_PAID', async () => {
            const kid = await createKid();
            const { body } = await issue(kid.id).expect(201);
            const id = body.items[0].id;
            await request(app)
                .post('/api/payments')
                .send({ invoiceIds: [id], method: 'CASH' })
                .expect(201);

            const response = await request(app)
                .delete(`/api/invoices/${id}`)
                .expect(409);

            expect(response.body.error.code).toBe('INVOICE_PAID');
            await request(app).get(`/api/invoices/${id}`).expect(200);
        });
    });

    test('deleting the kid keeps their invoices, without the kid (FR-018)', async () => {
        const kid = await createKid();
        const { body } = await issue(kid.id).expect(201);

        await request(app).delete(`/api/kids/${kid.id}`).expect(204);

        const invoice = await request(app)
            .get(`/api/invoices/${body.items[0].id}`)
            .expect(200);
        expect(invoice.body).toMatchObject({
            kidId: null,
            kidName: 'Marko Koval',
            total: 23800,
        });
    });
});
