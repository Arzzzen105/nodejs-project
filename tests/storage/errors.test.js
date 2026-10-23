import { describe, test, expect } from 'vitest';
import { DatabaseError, DatabaseErrors } from '../../src/storage/errors.js';
import * as facade from '../../src/storage/file-database.js';

// The HTTP contract of the engine: changing a status must be a deliberate decision.
const EXPECTED_STATUSES = {
    INVALID_BODY: 400,
    INVALID_ID: 400,
    INVALID_QUERY: 400,
    INVALID_COLLECTION: 400,
    NOT_FOUND: 404,
    COLLECTION_NOT_FOUND: 404,
    REFERENCE_RESTRICT: 409,
    UNIQUE_VIOLATION: 409,
    VALIDATION_ERROR: 422,
    REFERENCE_NOT_FOUND: 422,
    INVALID_CONFIG: 500,
    CORRUPT_RECORD: 500,
    CORRUPT_JOURNAL: 500,
    BROKEN_REFERENCES: 500,
    INVALID_TRANSACTION_USE: 500,
    TRANSACTION_CLOSED: 500,
    DATABASE_ALREADY_INITIALIZED: 500,
    DATABASE_NOT_READY: 503,
    DATABASE_CLOSED: 503,
    DATABASE_LOCKED: 503,
    DATABASE_NEEDS_RECOVERY: 503,
    TRANSACTION_TIMEOUT: 503,
};

describe('DatabaseErrors', () => {
    test('binds every code to its HTTP status', () => {
        const actual = Object.fromEntries(
            Object.entries(DatabaseErrors).map(([key, type]) => [
                key,
                type.status,
            ])
        );
        expect(actual).toEqual(EXPECTED_STATUSES);
    });

    test('every entry carries its own key as code and a description', () => {
        for (const [key, type] of Object.entries(DatabaseErrors)) {
            expect(type.code).toBe(key);
            expect(type.description).toMatch(/\.$/);
        }
    });

    test('the catalog cannot be changed', () => {
        expect(() => {
            DatabaseErrors.NOT_FOUND.status = 500;
        }).toThrow(TypeError);
        expect(() => {
            DatabaseErrors.NEW_CODE = {};
        }).toThrow(TypeError);
    });

    test('is internal to the engine and not exported by the facade', () => {
        expect(facade).not.toHaveProperty('DatabaseErrors');
        expect(facade.DatabaseError).toBe(DatabaseError);
    });
});

describe('DatabaseError', () => {
    test('takes code and status from the catalog', () => {
        const error = new DatabaseError(
            DatabaseErrors.UNIQUE_VIOLATION,
            '"email" must be unique.'
        );
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
            name: 'DatabaseError',
            code: 'UNIQUE_VIOLATION',
            status: 409,
            message: '"email" must be unique.',
        });
    });

    test.each([
        ['a code string', 'NOT_FOUND'],
        ['a look-alike object', { code: 'NOT_FOUND', status: 404 }],
        ['a misspelled entry', DatabaseErrors.NOT_FOND],
    ])('rejects %s instead of a catalog entry', (_label, type) => {
        expect(() => new DatabaseError(type, 'x')).toThrow(TypeError);
    });
});
