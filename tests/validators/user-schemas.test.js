import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createUser } from '../../src/validators/user-schemas.js';
import { createTestApp } from '../helpers/test-app.js';

const CONFIG = path.resolve(
    import.meta.dirname,
    '../../database/users/config.json'
);

const VALID = {
    username: 'manager',
    password: 'correct horse',
    role: 'MANAGER',
};

describe('user schemas', () => {
    test('createUser has the columns of the collection, with the password in place of its hash', async () => {
        const { columns } = JSON.parse(await fs.readFile(CONFIG, 'utf8'));
        const expected = Object.keys(columns)
            .filter((column) => column !== 'passwordHash')
            .concat('password');

        expect(Object.keys(createUser.shape).sort()).toEqual(expected.sort());
    });

    test.each([['id'], ['createdAt'], ['updatedAt'], ['passwordHash']])(
        'rejects "%s", which the client cannot set',
        (field) => {
            expect(
                createUser.safeParse({ ...VALID, [field]: 'x' }).success
            ).toBe(false);
        }
    );

    test.each([
        ['8 characters', 'x'.repeat(8), true],
        ['7 characters', 'x'.repeat(7), false],
        ['72 bytes', 'x'.repeat(72), true],
        ['73 bytes', 'x'.repeat(73), false],
        // a Cyrillic letter takes two bytes: bcrypt would ignore the rest
        ['36 Cyrillic letters, 72 bytes', 'я'.repeat(36), true],
        ['37 Cyrillic letters, 74 bytes', 'я'.repeat(37), false],
    ])('a password of %s: %s', (name, password, valid) => {
        expect(createUser.safeParse({ ...VALID, password }).success).toBe(
            valid
        );
    });

    test('rejects a role that does not exist', () => {
        expect(
            createUser.safeParse({ ...VALID, role: 'ASSISTANT' }).success
        ).toBe(false);
    });

    describe('agrees with the database on the username', () => {
        let repositories;
        let close;

        beforeEach(async () => {
            const testApp = await createTestApp();
            repositories = testApp.container.repositories;
            close = testApp.close;
        });

        afterEach(async () => close());

        /** Whether the database stores the account, past the service rules. */
        const databaseAccepts = (username) =>
            repositories.users
                .create({ username, passwordHash: 'x', role: 'MANAGER' })
                .then(
                    () => true,
                    () => false
                );

        test.each([
            ['valid', 'olena.koval-2'],
            ['3 characters', 'abc'],
            ['2 characters', 'ab'],
            ['50 characters', 'x'.repeat(50)],
            ['51 characters', 'x'.repeat(51)],
            ['capital letters', 'Olena'],
            ['a space', 'olena koval'],
            ['Cyrillic', 'олена'],
            ['an @', 'olena@kindergarten'],
        ])('%s', async (name, username) => {
            const schema = createUser.safeParse({ ...VALID, username }).success;

            expect(schema).toBe(await databaseAccepts(username));
        });
    });
});
