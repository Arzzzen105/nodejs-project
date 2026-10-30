import { describe, test, expect } from 'vitest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { isValidId } from '../../src/storage/validator.js';
import { idParams } from '../../src/validators/id-params.js';

describe('idParams', () => {
    const v7 = uuidv7();

    test.each([
        ['UUIDv7', v7],
        ['UUIDv7 in upper case', v7.toUpperCase()],
        ['UUIDv7 with a wrong variant', `${v7.slice(0, 19)}0${v7.slice(20)}`],
        ['UUIDv7 without dashes', v7.replaceAll('-', '')],
        ['UUIDv4', uuidv4()],
        ['nil UUID', '00000000-0000-0000-0000-000000000000'],
        ['max UUID', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
        ['garbage', 'abc'],
        ['empty string', ''],
        ['UUIDv7 with a new line', `${v7}\n`],
    ])('agrees with the check of the database: %s', (name, id) => {
        expect(idParams.safeParse({ id }).success).toBe(isValidId(id));
    });

    test('accepts a UUIDv7 and rejects other versions', () => {
        expect(idParams.safeParse({ id: v7 }).success).toBe(true);
        expect(idParams.safeParse({ id: uuidv4() }).success).toBe(false);
    });
});
