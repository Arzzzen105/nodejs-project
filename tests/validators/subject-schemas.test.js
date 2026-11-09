import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    createSubject,
    updateSubject,
} from '../../src/validators/subject-schemas.js';
import { createTestApp } from '../helpers/test-app.js';

const CONFIG = path.resolve(
    import.meta.dirname,
    '../../database/subjects/config.json'
);

const VALID = { name: 'Музика' };

describe('subject schemas', () => {
    test('createSubject has exactly the columns of the collection', async () => {
        const { columns } = JSON.parse(await fs.readFile(CONFIG, 'utf8'));

        expect(Object.keys(createSubject.shape).sort()).toEqual(
            Object.keys(columns).sort()
        );
    });

    test('updateSubject accepts any part of the fields and adds nothing', () => {
        expect(updateSubject.parse({})).toEqual({});
        expect(updateSubject.parse({ name: 'Малювання' })).toEqual({
            name: 'Малювання',
        });
    });

    test.each([['id'], ['unknown']])(
        'rejects "%s", which the client cannot set',
        (field) => {
            const body = { ...VALID, [field]: 'x' };

            expect(createSubject.safeParse(body).success).toBe(false);
            expect(updateSubject.safeParse({ [field]: 'x' }).success).toBe(
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
            repositories.subjects.create(body).then(
                () => true,
                () => false
            );

        test.each([
            ['valid subject', VALID],
            ['no name', {}],
            ['empty name', { name: '' }],
            ['name of 30', { name: 'x'.repeat(30) }],
            ['name of 31', { name: 'x'.repeat(31) }],
            ['name not a string', { name: 1 }],
            ['name null', { name: null }],
        ])('%s', async (name, body) => {
            expect(createSubject.safeParse(body).success).toBe(
                await databaseAccepts(body)
            );
        });
    });
});
