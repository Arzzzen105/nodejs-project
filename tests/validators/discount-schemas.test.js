import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    createDiscount,
    updateDiscount,
} from '../../src/validators/discount-schemas.js';
import { createTestApp } from '../helpers/test-app.js';

const CONFIG = path.resolve(
    import.meta.dirname,
    '../../database/discounts/config.json'
);

const VALID = { name: 'Пільга 10%', rate: 0.1 };

describe('discount schemas', () => {
    test('createDiscount has exactly the columns of the collection', async () => {
        const { columns } = JSON.parse(await fs.readFile(CONFIG, 'utf8'));

        expect(Object.keys(createDiscount.shape).sort()).toEqual(
            Object.keys(columns).sort()
        );
    });

    test('updateDiscount accepts any part of the fields and adds nothing', () => {
        expect(updateDiscount.parse({})).toEqual({});
        expect(updateDiscount.parse({ rate: 0.3 })).toEqual({ rate: 0.3 });
    });

    test.each([['id'], ['unknown']])(
        'rejects "%s", which the client cannot set',
        (field) => {
            const body = { ...VALID, [field]: 'x' };

            expect(createDiscount.safeParse(body).success).toBe(false);
            expect(updateDiscount.safeParse({ [field]: 'x' }).success).toBe(
                false
            );
        }
    );

    describe('agrees with the database', () => {
        let repositories;
        let close;

        beforeEach(async () => {
            const testApp = await createTestApp();
            repositories = testApp.container.repositories;
            close = testApp.close;
        });

        afterEach(async () => close());

        /** Whether the database stores the record, past the service rules. */
        const databaseAccepts = (body) =>
            repositories.discounts.create(body).then(
                () => true,
                () => false
            );

        test.each([
            ['valid discount', VALID],
            ['no name', { rate: 0.1 }],
            ['no rate', { name: 'Пільга' }],
            ['empty name', { ...VALID, name: '' }],
            ['name of 25', { ...VALID, name: 'x'.repeat(25) }],
            ['name of 26', { ...VALID, name: 'x'.repeat(26) }],
            ['rate 0.2', { ...VALID, rate: 0.2 }],
            ['rate 0.3', { ...VALID, rate: 0.3 }],
            ['rate 0', { ...VALID, rate: 0 }],
            ['rate 0.15', { ...VALID, rate: 0.15 }],
            ['rate 1', { ...VALID, rate: 1 }],
            ['negative rate', { ...VALID, rate: -0.1 }],
            ['rate over 1', { ...VALID, rate: 1.01 }],
            ['rate in percent', { ...VALID, rate: 10 }],
            ['rate as a string', { ...VALID, rate: '0.1' }],
            ['rate null', { ...VALID, rate: null }],
        ])('%s', async (name, body) => {
            expect(createDiscount.safeParse(body).success).toBe(
                await databaseAccepts(body)
            );
        });
    });
});
