import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    createGroup,
    updateGroup,
} from '../../src/validators/group-schemas.js';
import { createTestApp } from '../helpers/test-app.js';

const CONFIG = path.resolve(
    import.meta.dirname,
    '../../database/groups/config.json'
);

const VALID = { name: 'Сонечко', age: 3 };

describe('group schemas', () => {
    test('createGroup has exactly the columns of the collection', async () => {
        const { columns } = JSON.parse(await fs.readFile(CONFIG, 'utf8'));

        expect(Object.keys(createGroup.shape).sort()).toEqual(
            Object.keys(columns).sort()
        );
    });

    test('updateGroup accepts any part of the fields and adds nothing', () => {
        expect(updateGroup.parse({})).toEqual({});
        expect(updateGroup.parse({ age: 4 })).toEqual({ age: 4 });
    });

    test.each([['id'], ['createdAt'], ['updatedAt'], ['unknown']])(
        'rejects "%s", which the client cannot set',
        (field) => {
            const body = { ...VALID, [field]: 'x' };

            expect(createGroup.safeParse(body).success).toBe(false);
            expect(updateGroup.safeParse({ [field]: 'x' }).success).toBe(false);
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
            repositories.groups.create(body).then(
                () => true,
                () => false
            );

        const without = (field) => {
            const body = { ...VALID };
            delete body[field];
            return body;
        };

        test.each([
            ['valid group', VALID],
            ['no name', without('name')],
            ['no age', without('age')],
            ['empty name', { ...VALID, name: '' }],
            ['name of 100', { ...VALID, name: 'x'.repeat(100) }],
            ['name of 101', { ...VALID, name: 'x'.repeat(101) }],
            ['name not a string', { ...VALID, name: 1 }],
            ['age 1', { ...VALID, age: 1 }],
            ['age 2', { ...VALID, age: 2 }],
            ['age 5', { ...VALID, age: 5 }],
            ['age 6', { ...VALID, age: 6 }],
            ['age 2.5', { ...VALID, age: 2.5 }],
            ['age as a string', { ...VALID, age: '3' }],
            ['educatorId null', { ...VALID, educatorId: null }],
            ['educatorId not a string', { ...VALID, educatorId: 1 }],
            ['educatorId not a UUID', { ...VALID, educatorId: 'abc' }],
            ['assistantId null', { ...VALID, assistantId: null }],
        ])('%s', async (name, body) => {
            expect(createGroup.safeParse(body).success).toBe(
                await databaseAccepts(body)
            );
        });
    });
});
