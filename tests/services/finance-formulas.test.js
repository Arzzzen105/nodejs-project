import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    annualInvoiceLines,
    assistantSalary,
    cashIncome,
    educatorSalary,
    invoiceTotal,
    kidPrice,
    meals,
    bestPlan,
    money,
    monthlyInvoiceLines,
    planGroups,
    profitReport,
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

    describe('invoice lines (FR-014)', () => {
        const discount = { name: 'Large family', rate: 0.1 };

        test('a month of a kid of 3: tuition and meals, 15 000 + 400 × 22', () => {
            const lines = monthlyInvoiceLines(SETTINGS, { age: 3 });

            expect(lines).toEqual([
                { type: 'TUITION', months: 1, amount: 15000 },
                { type: 'MEALS', pricePerDay: 400, days: 22, amount: 8800 },
            ]);
            expect(invoiceTotal(lines)).toBe(23800);
        });

        test('the discount is a line of its own and leaves the meals alone (BR-30)', () => {
            const lines = monthlyInvoiceLines(
                SETTINGS,
                { age: 3 },
                { discount }
            );

            expect(lines).toEqual([
                { type: 'TUITION', months: 1, amount: 15000 },
                {
                    type: 'DISCOUNT',
                    name: 'Large family',
                    rate: 0.1,
                    amount: -1500,
                },
                { type: 'MEALS', pricePerDay: 400, days: 22, amount: 8800 },
            ]);
            // 13 500 + 8 800
            expect(invoiceTotal(lines)).toBe(22300);
        });

        test('only the meals when the year is paid for (BR-32)', () => {
            const lines = monthlyInvoiceLines(
                SETTINGS,
                { age: 5 },
                { discount, tuitionDue: false }
            );

            expect(lines).toEqual([
                { type: 'MEALS', pricePerDay: 600, days: 22, amount: 13200 },
            ]);
        });

        test('a year in advance: 12 months, less the discount, less 12% (FR-013)', () => {
            const lines = annualInvoiceLines(SETTINGS, discount);

            expect(lines).toEqual([
                { type: 'TUITION', months: 12, amount: 180000 },
                {
                    type: 'DISCOUNT',
                    name: 'Large family',
                    rate: 0.1,
                    amount: -18000,
                },
                { type: 'ANNUAL_DISCOUNT', rate: 0.12, amount: -19440 },
            ]);
            // 13 500 × 0.88 = 11 880 a month
            expect(invoiceTotal(lines)).toBe(11880 * 12);
        });

        test('the sums are those of kidPrice', () => {
            const kid = { age: 4, paymentPlan: 'ANNUAL' };
            const price = kidPrice(SETTINGS, kid, 0.3);
            const rate = { name: '30%', rate: 0.3 };

            expect(invoiceTotal(annualInvoiceLines(SETTINGS, rate))).toBe(
                price.payments.upfront
            );
            expect(
                invoiceTotal(
                    monthlyInvoiceLines(SETTINGS, kid, {
                        discount: rate,
                        tuitionDue: false,
                    })
                )
            ).toBe(price.payments.monthly);
            expect(
                invoiceTotal(
                    monthlyInvoiceLines(SETTINGS, kid, { discount: rate })
                )
            ).toBe(kidPrice(SETTINGS, { age: 4 }, 0.3).payments.monthly);
        });
    });

    describe('cashIncome (FR-017)', () => {
        test('tuition with its discounts, and meals, by the group of the invoice', () => {
            const income = cashIncome([
                {
                    groupId: 'a',
                    lines: annualInvoiceLines(SETTINGS, {
                        name: '10%',
                        rate: 0.1,
                    }),
                },
                {
                    groupId: 'a',
                    lines: monthlyInvoiceLines(
                        SETTINGS,
                        { age: 3 },
                        { tuitionDue: false }
                    ),
                },
                {
                    groupId: null,
                    lines: monthlyInvoiceLines(SETTINGS, { age: 2 }),
                },
            ]);

            expect(income).toEqual(
                new Map([
                    // 13 500 × 0.88 × 12; 400 × 22
                    ['a', { tuition: 142560, meals: 8800 }],
                    // 15 000; 300 × 22
                    [null, { tuition: 15000, meals: 6600 }],
                ])
            );
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

    describe('profitReport (FR-017)', () => {
        // rooms cost 5 000 a month here; the default is 50 000
        const settings = { ...SETTINGS, roomCostPerMonth: 5000 };
        const input = {
            groups: [
                {
                    id: 'a',
                    name: 'A',
                    age: 3,
                    hasEducator: true,
                    hasAssistant: true,
                    rooms: 1,
                    kids: [
                        { age: 3, paymentPlan: 'MONTHLY', discountRate: 0 },
                        { age: 3, paymentPlan: 'ANNUAL', discountRate: 0.2 },
                    ],
                },
                {
                    id: 'b',
                    name: 'B',
                    age: 5,
                    hasEducator: false,
                    hasAssistant: false,
                    rooms: 0,
                    kids: [
                        { age: 5, paymentPlan: 'MONTHLY', discountRate: 0.1 },
                    ],
                },
            ],
            managers: 1,
            teachers: 2,
            assistantsWithoutGroup: 1,
            classRooms: 3,
        };

        test('a group: income, expenses and profit line by line', () => {
            const [a] = profitReport(settings, input).groups;

            expect(a).toEqual({
                groupId: 'a',
                name: 'A',
                age: 3,
                kids: 2,
                // 15 000 + 10 560 (a twelfth of the annual payment); 2 × 8 800
                income: { tuition: 25560, meals: 17600, total: 43160 },
                // meals bought 2 × 8 800; educator 2 × 2 000; assistant base
                expenses: {
                    meals: 17600,
                    educator: 4000,
                    assistant: 20000,
                    room: 5000,
                    total: 46600,
                },
                profit: -3440,
            });
        });

        test('a group without staff pays no salaries', () => {
            const [, b] = profitReport(settings, input).groups;

            // 15 000 − 10% = 13 500; meals 600 × 22 = 13 200 in and out
            expect(b.income).toEqual({
                tuition: 13500,
                meals: 13200,
                total: 26700,
            });
            expect(b.expenses).toEqual({
                meals: 13200,
                educator: 0,
                assistant: 0,
                room: 0,
                total: 13200,
            });
            expect(b.profit).toBe(13500);
        });

        test('shared expenses: what belongs to no group', () => {
            expect(profitReport(settings, input).shared).toEqual({
                managers: { count: 1, amount: 80000 },
                teachers: { count: 2, amount: 80000 },
                assistantsWithoutGroup: { count: 1, amount: 20000 },
                classRooms: { count: 3, amount: 15000 },
                total: 195000,
            });
        });

        test('the profits of the groups less the shared expenses are the total profit', () => {
            const report = profitReport(settings, input);

            // income 43 160 + 26 700; expenses 46 600 + 13 200 + 195 000
            expect(report.total).toEqual({
                income: 69860,
                expenses: 254800,
                profit: -184940,
            });
            const groups = report.groups.reduce((sum, g) => sum + g.profit, 0);
            expect(money(groups - report.shared.total)).toBe(
                report.total.profit
            );
        });

        test('meals are income and expenses apart, even when equal (BR-33)', () => {
            const [a] = profitReport(settings, input).groups;

            expect(a.income.meals).toBe(17600);
            expect(a.expenses.meals).toBe(17600);
        });

        test('an empty kindergarten has only shared expenses', () => {
            const report = profitReport(settings, {
                groups: [],
                managers: 1,
                teachers: 0,
                assistantsWithoutGroup: 0,
                classRooms: 0,
            });

            expect(report.total).toEqual({
                income: 0,
                expenses: 80000,
                profit: -80000,
            });
        });
    });

    describe('planGroups (forecast)', () => {
        const sizes = (groups) => groups.map((group) => group.kids.length);

        test.each([
            [20, [20]],
            [40, [20, 20]],
            // the fewest groups, kids shared evenly
            [35, [18, 17]],
            [41, [14, 14, 13]],
            [1, [1]],
            [0, []],
        ])('%i kids make groups of %j', (kids, expected) => {
            expect(sizes(planGroups({ 3: kids }, { groupSize: 20 }))).toEqual(
                expected
            );
        });

        test('kids of different ages never share a group (BR-02)', () => {
            const groups = planGroups({ 2: 5, 4: 5 }, { groupSize: 20 });

            expect(groups.map((group) => group.age)).toEqual([2, 4]);
            expect(groups[1].kids.every((kid) => kid.age === 4)).toBe(true);
        });

        test('every group has an educator, an assistant and a room', () => {
            const [group] = planGroups({ 3: 10 }, { groupSize: 20 });

            expect(group).toMatchObject({
                hasEducator: true,
                hasAssistant: true,
                rooms: 1,
            });
        });

        test('the assumptions are given to every kid', () => {
            const [group] = planGroups(
                { 3: 17 },
                { groupSize: 20, averageDiscount: 0.1, annualShare: 0.5 }
            );
            const annual = group.kids.filter(
                (kid) => kid.paymentPlan === 'ANNUAL'
            );

            // half of 17 is 8.5: rounded to 9 whole kids
            expect(annual).toHaveLength(9);
            expect(group.kids.every((kid) => kid.discountRate === 0.1)).toBe(
                true
            );
        });
    });

    describe('bestPlan (forecast)', () => {
        const options = { groupSize: 20, maxGroups: 15 };
        const plan = (kids, settings = SETTINGS, extra = {}) =>
            bestPlan(settings, kids, { ...options, ...extra });
        const sizes = (groups) => groups.map((group) => group.kids.length);
        const profit = (groups, settings = SETTINGS) =>
            profitReport(settings, {
                groups,
                managers: 0,
                teachers: 0,
                assistantsWithoutGroup: 0,
                classRooms: 0,
            }).total.profit;

        test('a new group of 12 pays: 12 × (5 000 + 3 000) = 96 000 > 50 000 + 20 000', () => {
            // 150 kids, before shared expenses: 12 groups of 12–13 earn
            // 1 062 000, the fewest groups (8) 958 000
            const groups = plan({ 3: 150 });

            expect(groups).toHaveLength(12);
            expect(profit(groups)).toBe(1062000);
            expect(profit(planGroups({ 3: 150 }, { groupSize: 20 }))).toBe(
                958000
            );
        });

        test('20 kids stay one group: two of 10 earn less', () => {
            // 126 000 against 2 × (10 × 13 000 − 70 000) = 120 000
            expect(sizes(plan({ 3: 20 }))).toEqual([20]);
        });

        test('past 180 kids the groups fill up: there are at most 15', () => {
            expect(sizes(plan({ 3: 240 }))).toEqual(Array(15).fill(16));
            expect(sizes(plan({ 3: 300 }))).toEqual(Array(15).fill(20));
        });

        test('the 15 groups are shared among the ages for the most profit', () => {
            const groups = plan({ 2: 120, 3: 120 });

            expect(groups).toHaveLength(15);
            expect(profit(groups)).toBeGreaterThan(
                profit(planGroups({ 2: 120, 3: 120 }, { groupSize: 20 }))
            );
        });

        test('follows the settings: with a rent of 100 000 the fewest groups win', () => {
            const settings = { ...SETTINGS, roomCostPerMonth: 100000 };

            expect(sizes(plan({ 3: 150 }, settings))).toEqual(
                sizes(planGroups({ 3: 150 }, { groupSize: 20 }))
            );
        });

        test('of plans with the same profit, the one with fewer groups', () => {
            // with no bonus over the threshold, every split of 24 kids into
            // groups of 12 or more earns alike but for the rooms and the base
            const settings = {
                ...SETTINGS,
                educatorBonusPerExtraKid: 0,
                assistantBonusPerExtraKid: 0,
                roomCostPerMonth: 0,
                assistantBaseSalary: 0,
            };

            expect(sizes(plan({ 3: 24 }, settings))).toEqual([12, 12]);
        });

        test('never better than nothing: no kids, no groups', () => {
            expect(plan({ 2: 0, 3: 0 })).toEqual([]);
        });

        test('null when the kids do not fit', () => {
            expect(plan({ 2: 300, 3: 1 })).toBeNull();
        });

        test('is never worse than the fewest groups', () => {
            for (const kids of [7, 25, 33, 59, 101, 179, 222]) {
                expect(profit(plan({ 4: kids }))).toBeGreaterThanOrEqual(
                    profit(planGroups({ 4: kids }, { groupSize: 20 }))
                );
            }
        });
    });
});
