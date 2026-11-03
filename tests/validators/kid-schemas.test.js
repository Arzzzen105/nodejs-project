import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createKid, updateKid } from '../../src/validators/kid-schemas.js';
import { createTestApp } from '../helpers/test-app.js';

const CONFIG = path.resolve(
    import.meta.dirname,
    '../../database/kids/config.json'
);

const VALID = { firstName: 'Марко', lastName: 'Коваль', age: 3, sex: 'MALE' };

describe('kid schemas', () => {
    test('createKid has exactly the columns of the collection', async () => {
        const { columns } = JSON.parse(await fs.readFile(CONFIG, 'utf8'));

        expect(Object.keys(createKid.shape).sort()).toEqual(
            Object.keys(columns).sort()
        );
    });

    test('updateKid accepts any part of the fields and adds nothing', () => {
        expect(updateKid.parse({})).toEqual({});
        expect(updateKid.parse({ age: 4 })).toEqual({ age: 4 });
    });

    test.each([['id'], ['createdAt'], ['updatedAt'], ['unknown']])(
        'rejects "%s", which the client cannot set',
        (field) => {
            const body = { ...VALID, [field]: 'x' };

            expect(createKid.safeParse(body).success).toBe(false);
            expect(updateKid.safeParse({ [field]: 'x' }).success).toBe(false);
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
            repositories.kids.create(body).then(
                () => true,
                () => false
            );

        const without = (field) => {
            const body = { ...VALID };
            delete body[field];
            return body;
        };

        test.each([
            ['valid kid', VALID],
            ['no firstName', without('firstName')],
            ['no lastName', without('lastName')],
            ['no age', without('age')],
            ['no sex', without('sex')],
            ['empty firstName', { ...VALID, firstName: '' }],
            ['firstName of 100', { ...VALID, firstName: 'x'.repeat(100) }],
            ['firstName of 101', { ...VALID, firstName: 'x'.repeat(101) }],
            ['empty lastName', { ...VALID, lastName: '' }],
            ['lastName of 100', { ...VALID, lastName: 'x'.repeat(100) }],
            ['lastName of 101', { ...VALID, lastName: 'x'.repeat(101) }],
            ['firstName not a string', { ...VALID, firstName: 1 }],
            ['age 1', { ...VALID, age: 1 }],
            ['age 2', { ...VALID, age: 2 }],
            ['age 5', { ...VALID, age: 5 }],
            ['age 6', { ...VALID, age: 6 }],
            ['age 2.5', { ...VALID, age: 2.5 }],
            ['age as a string', { ...VALID, age: '3' }],
            ['sex FEMALE', { ...VALID, sex: 'FEMALE' }],
            ['unknown sex', { ...VALID, sex: 'OTHER' }],
            ['speech lessons', { ...VALID, needsSpeechLessons: true }],
            ['speech lessons not boolean', { ...VALID, needsSpeechLessons: 1 }],
            ['groupId null', { ...VALID, groupId: null }],
            ['groupId not a string', { ...VALID, groupId: 1 }],
            ['groupId not a UUID', { ...VALID, groupId: 'abc' }],
            ['discountId null', { ...VALID, discountId: null }],
            ['motherId null', { ...VALID, motherId: null }],
            ['fatherId null', { ...VALID, fatherId: null }],
        ])('%s', async (name, body) => {
            expect(createKid.safeParse(body).success).toBe(
                await databaseAccepts(body)
            );
        });
    });
});
