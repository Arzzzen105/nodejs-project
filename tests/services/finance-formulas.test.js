import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    assistantSalary,
    educatorSalary,
    kidPrice,
    meals,
    money,
    tuition,
} from '../../src/services/finance-formulas.js';

// the defaults of database/settings/config.json: the values of the requirements
const { columns } = JSON.parse(
    fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../database/settings/config.json'
        ),
        'utf8'
    )
);
const SETTINGS = Object.fromEntries(
    Object.entries(columns).map(([name, column]) => [name, column.default])
);

describe('finance formulas', () => {
    describe('tuition (FR-012, FR-013)', () => {
        test('without a discount: 15 000 a month (BR-20)', () => {
            expect(tuition(SETTINGS)).toEqual({
                base: 15000,
                discountRate: 0,
                discount: 0,
                afterDiscount: 15000,
                annualDiscountRate: 0,
                annualDiscount: 0,
                perMonth: 15000,
            });
        });

        test('a 20% discount: 15 000 − 3 000 = 12 000', () => {
            expect(tuition(SETTINGS, { discountRate: 0.2 })).toMatchObject({
                discount: 3000,
                afterDiscount: 12000,
                perMonth: 12000,
            });
        });

        test('annual plan: 12% off what is left after the discount (BR-28): 12 000 − 1 440 = 10 560', () => {
            expect(
                tuition(SETTINGS, { discountRate: 0.2, paymentPlan: 'ANNUAL' })
            ).toMatchObject({
                afterDiscount: 12000,
                annualDiscountRate: 0.12,
                annualDiscount: 1440,
                perMonth: 10560,
            });
        });

        test('annual plan without a discount: 15 000 − 1 800 = 13 200', () => {
            expect(tuition(SETTINGS, { paymentPlan: 'ANNUAL' }).perMonth).toBe(
                13200
            );
        });
    });

    describe('meals (BR-22, BR-23, BR-33)', () => {
        test.each([
            [2, 300, 6600],
            [3, 400, 8800],
            [4, 500, 11000],
            [5, 600, 13200],
        ])('age %i: %i a day × 22 days = %i', (age, perDay, perMonth) => {
            expect(meals(SETTINGS, age)).toEqual({
                pricePerDay: perDay,
                costPerDay: perDay,
                days: 22,
                perMonth,
                costPerMonth: perMonth,
            });
        });

        test('the cost for the kindergarten is a value of its own', () => {
            const food = meals({ ...SETTINGS, mealCostAge3: 250 }, 3);

            expect(food.perMonth).toBe(8800);
            expect(food.costPerMonth).toBe(5500);
        });
    });

    describe('kidPrice', () => {
        test('monthly plan: tuition and meals every month', () => {
            const price = kidPrice(SETTINGS, { age: 3 }, 0.2);

            // 12 000 tuition + 8 800 meals
            expect(price).toMatchObject({
                paymentPlan: 'MONTHLY',
                totalPerMonth: 20800,
                payments: { upfront: 0, monthly: 20800 },
            });
        });

        test('annual plan: the tuition of a year in advance, the meals monthly (BR-32)', () => {
            const price = kidPrice(
                SETTINGS,
                { age: 3, paymentPlan: 'ANNUAL' },
                0.2
            );

            // 10 560 × 12 = 126 720 in advance; 8 800 of meals each month
            expect(price).toMatchObject({
                paymentPlan: 'ANNUAL',
                totalPerMonth: 19360,
                payments: { upfront: 126720, monthly: 8800 },
            });
        });

        test('neither discount touches the meals (BR-30, BR-31)', () => {
            const price = kidPrice(
                SETTINGS,
                { age: 5, paymentPlan: 'ANNUAL' },
                0.3
            );

            expect(price.meals.perMonth).toBe(13200);
        });

        test('a changed setting is used at once (BR-24)', () => {
            const price = kidPrice(
                { ...SETTINGS, tuitionPerMonth: 20000, mealPriceAge2: 350 },
                { age: 2 }
            );

            // 20 000 + 350 × 22
            expect(price.totalPerMonth).toBe(27700);
        });
    });

    describe('salaries (BR-36–BR-39)', () => {
        test.each([
            [0, 0],
            [10, 20000],
            [12, 24000],
            // 13 × 2 000 + 1 × 5 000
            [13, 31000],
            // 20 × 2 000 + 8 × 5 000
            [20, 80000],
        ])('educator of %i kids: %i', (kids, salary) => {
            expect(educatorSalary(SETTINGS, kids)).toBe(salary);
        });

        test.each([
            [0, 20000],
            [12, 20000],
            // 20 000 + 3 × 3 000
            [15, 29000],
            // 20 000 + 8 × 3 000
            [20, 44000],
        ])('assistant of %i kids: %i', (kids, salary) => {
            expect(assistantSalary(SETTINGS, kids)).toBe(salary);
        });

        test('the threshold is a setting too', () => {
            const settings = { ...SETTINGS, extraKidsThreshold: 10 };

            // 12 × 2 000 + 2 × 5 000; 20 000 + 2 × 3 000
            expect(educatorSalary(settings, 12)).toBe(34000);
            expect(assistantSalary(settings, 12)).toBe(26000);
        });
    });

    test('money is rounded to kopecks', () => {
        expect(money(0.1 + 0.2)).toBe(0.3);
        expect(money(10.005 * 3)).toBe(30.02);
    });
});
