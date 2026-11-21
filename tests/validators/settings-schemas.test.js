import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { updateSettings } from '../../src/validators/settings-schemas.js';
import { createTestApp } from '../helpers/test-app.js';

const CONFIG = path.resolve(
    import.meta.dirname,
    '../../database/settings/config.json'
);

describe('settings schemas', () => {
    test('updateSettings has exactly the columns of the collection', async () => {
        const { columns } = JSON.parse(await fs.readFile(CONFIG, 'utf8'));

        expect(Object.keys(updateSettings.shape).sort()).toEqual(
            Object.keys(columns).sort()
        );
    });

    test.each([['id'], ['createdAt'], ['updatedAt'], ['currency']])(
        'rejects "%s", which the client cannot set',
        (field) => {
            expect(updateSettings.safeParse({ [field]: 1 }).success).toBe(
                false
            );
        }
    );

    describe('agrees with the database', () => {
        let services;
        let close;

        beforeEach(async () => {
            const testApp = await createTestApp();
            services = testApp.container.services;
            close = testApp.close;
        });

        afterEach(async () => close());

        /** Whether the database stores the change. */
        const databaseAccepts = (changes) =>
            services.settings.update(changes).then(
                () => true,
                () => false
            );

        test.each([
            ['tuition of 0', { tuitionPerMonth: 0 }],
            ['negative tuition', { tuitionPerMonth: -1 }],
            ['tuition with kopecks', { tuitionPerMonth: 15000.5 }],
            ['annual discount of 0', { annualDiscount: 0 }],
            ['annual discount of 1', { annualDiscount: 1 }],
            ['annual discount over 1', { annualDiscount: 1.01 }],
            ['negative annual discount', { annualDiscount: -0.1 }],
            ['1 workday', { workdaysPerMonth: 1 }],
            ['31 workdays', { workdaysPerMonth: 31 }],
            ['32 workdays', { workdaysPerMonth: 32 }],
            ['0 workdays', { workdaysPerMonth: 0 }],
            ['fractional workdays', { workdaysPerMonth: 21.5 }],
            ['negative meal price', { mealPriceAge3: -5 }],
            ['negative meal cost', { mealCostAge4: -5 }],
            ['threshold of 0', { extraKidsThreshold: 0 }],
            ['fractional threshold', { extraKidsThreshold: 12.5 }],
            ['negative salary', { managerSalary: -1 }],
            ['room cost', { roomCostPerMonth: 5000 }],
            ['a string', { teacherSalary: '40000' }],
            ['lessons of 15 minutes', { lessonMinutes: 15 }],
            ['lessons of 60 minutes', { lessonMinutes: 60 }],
            ['lessons of 20 minutes', { lessonMinutes: 20 }],
            ['lessons of 90 minutes', { lessonMinutes: 90 }],
        ])('%s', async (name, changes) => {
            const schema = updateSettings.safeParse(changes).success;

            expect(schema).toBe(await databaseAccepts(changes));
        });
    });
});
