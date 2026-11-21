import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { createTestApp } from '../helpers/test-app.js';

describe('GET /api/kids/:id/price (FR-012, FR-013)', () => {
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

    const createKid = (fields = {}) =>
        repositories.kids.create({
            firstName: 'Marko',
            lastName: 'Koval',
            age: 3,
            sex: 'MALE',
            ...fields,
        });
    const createDiscount = (rate) =>
        repositories.discounts.create({ name: `Discount ${rate}`, rate });

    test('a kid of 3 without a discount, monthly: 15 000 + 400 × 22', async () => {
        const kid = await createKid();

        const { body } = await request(app)
            .get(`/api/kids/${kid.id}/price`)
            .expect(200);

        expect(body).toEqual({
            kidId: kid.id,
            paymentPlan: 'MONTHLY',
            tuition: {
                base: 15000,
                discountRate: 0,
                discount: 0,
                afterDiscount: 15000,
                annualDiscountRate: 0,
                annualDiscount: 0,
                perMonth: 15000,
            },
            meals: { pricePerDay: 400, days: 22, perMonth: 8800 },
            totalPerMonth: 23800,
            payments: { upfront: 0, monthly: 23800 },
        });
    });

    test('with a 20% discount on the annual plan', async () => {
        const discount = await createDiscount(0.2);
        const kid = await createKid({
            discountId: discount.id,
            paymentPlan: 'ANNUAL',
        });

        const { body } = await request(app)
            .get(`/api/kids/${kid.id}/price`)
            .expect(200);

        // 15 000 − 3 000 = 12 000; − 12% = 10 560; × 12 = 126 720 in advance
        expect(body.tuition).toMatchObject({
            discount: 3000,
            annualDiscount: 1440,
            perMonth: 10560,
        });
        expect(body.payments).toEqual({ upfront: 126720, monthly: 8800 });
    });

    test('follows the settings at once', async () => {
        const kid = await createKid({ age: 2 });
        await request(app)
            .patch('/api/finance/settings')
            .send({ tuitionPerMonth: 16000, mealPriceAge2: 320 })
            .expect(200);

        const { body } = await request(app)
            .get(`/api/kids/${kid.id}/price`)
            .expect(200);

        // 16 000 + 320 × 22
        expect(body.totalPerMonth).toBe(23040);
    });

    test('answers 404 for a missing kid', async () => {
        await request(app).get(`/api/kids/${uuidv7()}/price`).expect(404);
    });

    describe('who sees it', () => {
        test('the parents of the kid, but not of another kid (2.6)', async () => {
            const mom = await repositories.parents.create({
                firstName: 'Olena',
                lastName: 'Koval',
                sex: 'FEMALE',
            });
            const own = await createKid({ motherId: mom.id });
            const other = await createKid();
            const { auth } = await signIn({ role: 'PARENT', parentId: mom.id });

            await request(rawApp)
                .get(`/api/kids/${own.id}/price`)
                .set(auth)
                .expect(200);
            await request(rawApp)
                .get(`/api/kids/${other.id}/price`)
                .set(auth)
                .expect(403);
        });

        test('the manager', async () => {
            const kid = await createKid();
            const { auth } = await signIn({ role: 'MANAGER' });

            await request(rawApp)
                .get(`/api/kids/${kid.id}/price`)
                .set(auth)
                .expect(200);
        });
    });

    describe('the payment plan (FR-013)', () => {
        test('is monthly by default', async () => {
            const { body } = await request(app)
                .post('/api/kids')
                .send({
                    firstName: 'Marko',
                    lastName: 'Koval',
                    age: 3,
                    sex: 'MALE',
                })
                .expect(201);

            expect(body.paymentPlan).toBe('MONTHLY');
        });

        test('the admin changes it', async () => {
            const kid = await createKid();

            const { body } = await request(app)
                .patch(`/api/kids/${kid.id}`)
                .send({ paymentPlan: 'ANNUAL' })
                .expect(200);

            expect(body.paymentPlan).toBe('ANNUAL');
        });

        test('the manager does not: it is a financial value', async () => {
            const kid = await createKid();
            const { auth } = await signIn({ role: 'MANAGER' });

            await request(rawApp)
                .patch(`/api/kids/${kid.id}`)
                .set(auth)
                .send({ paymentPlan: 'ANNUAL' })
                .expect(403);
            await request(rawApp)
                .post('/api/kids')
                .set(auth)
                .send({
                    firstName: 'Taras',
                    lastName: 'Koval',
                    age: 3,
                    sex: 'MALE',
                    paymentPlan: 'ANNUAL',
                })
                .expect(403);
        });

        test('the manager keeps it when writing other fields', async () => {
            const kid = await createKid({ paymentPlan: 'ANNUAL' });
            const { auth } = await signIn({ role: 'MANAGER' });

            await request(rawApp)
                .patch(`/api/kids/${kid.id}`)
                .set(auth)
                .send({ firstName: 'Taras' })
                .expect(200);
            // PUT without the plan would reset it to MONTHLY
            await request(rawApp)
                .put(`/api/kids/${kid.id}`)
                .set(auth)
                .send({
                    firstName: 'Taras',
                    lastName: 'Koval',
                    age: 3,
                    sex: 'MALE',
                })
                .expect(403);
        });
    });
});
