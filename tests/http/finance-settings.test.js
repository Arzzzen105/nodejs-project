import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';

describe('/api/finance/settings', () => {
    let app;
    let rawApp;
    let signIn;
    let close;

    beforeEach(async () => {
        ({ app, rawApp, signIn, close } = await createTestApp());
    });

    afterEach(async () => close());

    test('a new database has the values of the requirements', async () => {
        const { body } = await request(app)
            .get('/api/finance/settings')
            .expect(200);

        expect(body).toMatchObject({
            tuitionPerMonth: 15000,
            annualDiscount: 0.12,
            workdaysPerMonth: 22,
            mealPriceAge2: 300,
            mealPriceAge5: 600,
            managerSalary: 80000,
            teacherSalary: 40000,
            assistantBaseSalary: 20000,
            assistantBonusPerExtraKid: 3000,
            educatorPayPerKid: 2000,
            educatorBonusPerExtraKid: 5000,
            extraKidsThreshold: 12,
            roomCostPerMonth: 50000,
        });
    });

    test('there is one record of settings, however often it is read', async () => {
        const first = await request(app).get('/api/finance/settings');
        const second = await request(app).get('/api/finance/settings');

        expect(second.body.id).toBe(first.body.id);
    });

    test('the admin changes some values and keeps the rest (BR-24, BR-40)', async () => {
        const { body } = await request(app)
            .patch('/api/finance/settings')
            .send({ mealPriceAge3: 450, teacherSalary: 42000 })
            .expect(200);

        expect(body).toMatchObject({
            mealPriceAge3: 450,
            teacherSalary: 42000,
            mealPriceAge2: 300,
        });
        const again = await request(app).get('/api/finance/settings');
        expect(again.body.mealPriceAge3).toBe(450);
    });

    test.each([
        ['a discount over 1', { annualDiscount: 1.5 }],
        ['a negative price', { tuitionPerMonth: -100 }],
        ['an unknown field', { currency: 'USD' }],
        ['the id', { id: 'x' }],
    ])('answers 422 for %s', async (name, body) => {
        const response = await request(app)
            .patch('/api/finance/settings')
            .send(body)
            .expect(422);

        expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('the manager reads the settings but does not change them', async () => {
        const { auth } = await signIn({ role: 'MANAGER' });

        await request(rawApp)
            .get('/api/finance/settings')
            .set(auth)
            .expect(200);
        await request(rawApp)
            .patch('/api/finance/settings')
            .set(auth)
            .send({ tuitionPerMonth: 1 })
            .expect(403);

        const { body } = await request(app).get('/api/finance/settings');
        expect(body.tuitionPerMonth).toBe(15000);
    });
});
