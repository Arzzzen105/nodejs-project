import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    createAssistant,
    updateAssistant,
} from '../../src/validators/assistant-schemas.js';
import { createTestApp } from '../helpers/test-app.js';

const CONFIG = path.resolve(
    import.meta.dirname,
    '../../database/assistants/config.json'
);

const VALID = { firstName: 'Тетяна', lastName: 'Шевчук' };

describe('assistant schemas', () => {
    test('createAssistant has exactly the columns of the collection', async () => {
        const { columns } = JSON.parse(await fs.readFile(CONFIG, 'utf8'));

        expect(Object.keys(createAssistant.shape).sort()).toEqual(
            Object.keys(columns).sort()
        );
    });

    test('updateAssistant accepts any part of the fields and adds nothing', () => {
        expect(updateAssistant.parse({})).toEqual({});
        expect(updateAssistant.parse({ lastName: 'Бойко' })).toEqual({
            lastName: 'Бойко',
        });
    });

    test.each([['id'], ['createdAt'], ['updatedAt'], ['email'], ['phone']])(
        'rejects "%s", which the client cannot set',
        (field) => {
            const body = { ...VALID, [field]: 'x' };

            expect(createAssistant.safeParse(body).success).toBe(false);
            expect(updateAssistant.safeParse({ [field]: 'x' }).success).toBe(
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
            repositories.assistants.create(body).then(
                () => true,
                () => false
            );

        const without = (field) => {
            const body = { ...VALID };
            delete body[field];
            return body;
        };

        test.each([
            ['valid assistant', VALID],
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
            expect(createAssistant.safeParse(body).success).toBe(
                await databaseAccepts(body)
            );
        });
    });
});
