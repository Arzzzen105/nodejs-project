import { describe, test, expect } from 'vitest';
import { PasswordHasher } from '../../src/security/password-hasher.js';

describe('PasswordHasher', () => {
    const hasher = new PasswordHasher({ rounds: 4 });

    test('the hash is not the password and matches only it', async () => {
        const hash = await hasher.hash('correct horse');

        expect(hash).not.toContain('correct horse');
        await expect(hasher.verify('correct horse', hash)).resolves.toBe(true);
        await expect(hasher.verify('correct hors', hash)).resolves.toBe(false);
    });

    test('the same password gets a new salt each time', async () => {
        const first = await hasher.hash('correct horse');
        const second = await hasher.hash('correct horse');

        expect(first).not.toBe(second);
        await expect(hasher.verify('correct horse', second)).resolves.toBe(
            true
        );
    });

    test('uses the given cost', async () => {
        const hash = await new PasswordHasher({ rounds: 5 }).hash('x');

        expect(hash).toMatch(/^\$2b\$05\$/);
    });

    test('accepts a password of 72 bytes', async () => {
        await expect(hasher.hash('a'.repeat(72))).resolves.toBeTypeOf('string');
    });

    test.each([
        ['73 ASCII characters', 'a'.repeat(73)],
        // a Cyrillic letter takes two bytes in UTF-8
        ['37 Cyrillic letters', 'я'.repeat(37)],
    ])(
        'rejects a password over 72 bytes: %s, whose tail bcrypt would ignore',
        async (name, password) => {
            await expect(hasher.hash(password)).rejects.toThrow(RangeError);
        }
    );
});
