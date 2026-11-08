import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    createParent,
    updateParent,
} from '../../src/validators/parent-schemas.js';
import { createTestApp } from '../helpers/test-app.js';

const CONFIG = path.resolve(
    import.meta.dirname,
    '../../database/parents/config.json'
);

const VALID = {
    firstName: 'Олена',
    lastName: 'Коваленко',
    sex: 'FEMALE',
    workplace: 'Школа',
    email: 'olena@example.com',
    phone: '+380501234567',
};

describe('parent schemas', () => {
    test('createParent has exactly the columns of the collection', async () => {
        const { columns } = JSON.parse(await fs.readFile(CONFIG, 'utf8'));

        expect(Object.keys(createParent.shape).sort()).toEqual(
            Object.keys(columns).sort()
        );
    });

    test('updateParent accepts any part of the fields and adds nothing', () => {
        expect(updateParent.parse({})).toEqual({});
        expect(updateParent.parse({ workplace: 'Нова робота' })).toEqual({
            workplace: 'Нова робота',
        });
    });

    test.each([['id'], ['createdAt'], ['updatedAt'], ['unknown']])(
        'rejects "%s", which the client cannot set',
        (field) => {
            const body = { ...VALID, [field]: 'x' };

            expect(createParent.safeParse(body).success).toBe(false);
            expect(updateParent.safeParse({ [field]: 'x' }).success).toBe(
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
            repositories.parents.create(body).then(
                () => true,
                () => false
            );

        const without = (field) => {
            const body = { ...VALID };
            delete body[field];
            return body;
        };

        test.each([
            ['valid parent', VALID],
            ['no firstName', without('firstName')],
            ['no lastName', without('lastName')],
            ['no sex', without('sex')],
            ['empty firstName', { ...VALID, firstName: '' }],
            ['firstName of 100', { ...VALID, firstName: 'x'.repeat(100) }],
            ['firstName of 101', { ...VALID, firstName: 'x'.repeat(101) }],
            ['empty lastName', { ...VALID, lastName: '' }],
            ['lastName of 100', { ...VALID, lastName: 'x'.repeat(100) }],
            ['lastName of 101', { ...VALID, lastName: 'x'.repeat(101) }],
            ['firstName not a string', { ...VALID, firstName: 1 }],
            ['sex MALE', { ...VALID, sex: 'MALE' }],
            ['sex FEMALE', { ...VALID, sex: 'FEMALE' }],
            ['unknown sex', { ...VALID, sex: 'OTHER' }],
            ['workplace null', { ...VALID, workplace: null }],
            ['workplace not a string', { ...VALID, workplace: 123 }],
            ['email null', { ...VALID, email: null }],
            ['invalid email format', { ...VALID, email: 'bad-email' }],
            ['phone null', { ...VALID, phone: null }],
            ['invalid phone format', { ...VALID, phone: 'abc' }],
        ])('%s', async (name, body) => {
            expect(createParent.safeParse(body).success).toBe(
                await databaseAccepts(body)
            );
        });
    });
});
