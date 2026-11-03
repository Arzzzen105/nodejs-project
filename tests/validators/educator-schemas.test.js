import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    createEducator,
    updateEducator,
} from '../../src/validators/educator-schemas.js';
import { createTestApp } from '../helpers/test-app.js';

const CONFIG = path.resolve(
    import.meta.dirname,
    '../../database/educators/config.json'
);

const VALID = { firstName: 'Ірина', lastName: 'Мельник' };

describe('educator schemas', () => {
    test('createEducator has exactly the columns of the collection', async () => {
        const { columns } = JSON.parse(await fs.readFile(CONFIG, 'utf8'));

        expect(Object.keys(createEducator.shape).sort()).toEqual(
            Object.keys(columns).sort()
        );
    });

    test('updateEducator accepts any part of the fields and adds nothing', () => {
        expect(updateEducator.parse({})).toEqual({});
        expect(updateEducator.parse({ lastName: 'Бойко' })).toEqual({
            lastName: 'Бойко',
        });
    });

    test.each([['id'], ['createdAt'], ['updatedAt'], ['email'], ['phone']])(
        'rejects "%s", which the client cannot set',
        (field) => {
            const body = { ...VALID, [field]: 'x' };

            expect(createEducator.safeParse(body).success).toBe(false);
            expect(updateEducator.safeParse({ [field]: 'x' }).success).toBe(
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
            repositories.educators.create(body).then(
                () => true,
                () => false
            );

        const without = (field) => {
            const body = { ...VALID };
            delete body[field];
            return body;
        };

        test.each([
            ['valid educator', VALID],
            ['no firstName', without('firstName')],
            ['no lastName', without('lastName')],
            ['empty firstName', { ...VALID, firstName: '' }],
            ['firstName of 100', { ...VALID, firstName: 'x'.repeat(100) }],
            ['firstName of 101', { ...VALID, firstName: 'x'.repeat(101) }],
            ['empty lastName', { ...VALID, lastName: '' }],
            ['lastName of 100', { ...VALID, lastName: 'x'.repeat(100) }],
            ['lastName of 101', { ...VALID, lastName: 'x'.repeat(101) }],
            ['firstName not a string', { ...VALID, firstName: 1 }],
            ['lastName null', { ...VALID, lastName: null }],
        ])('%s', async (name, body) => {
            expect(createEducator.safeParse(body).success).toBe(
                await databaseAccepts(body)
            );
        });
    });
});
