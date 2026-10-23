import { describe, test, expect } from 'vitest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { DatabaseError } from '../../src/storage/errors.js';
import {
    COLLECTION_NAME,
    isPlainObject,
    isValidId,
    validateId,
    validateConfig,
    validateField,
    normalizeRecord,
} from '../../src/storage/validator.js';

function config(overrides = {}) {
    return {
        table: 'items',
        primaryKey: 'id',
        columns: { title: { type: 'string' } },
        indexes: [],
        ...overrides,
    };
}

describe('isPlainObject', () => {
    test.each([
        [{}, true],
        [{ a: 1 }, true],
        [[], false],
        [null, false],
        ['str', false],
        [1, false],
        [undefined, false],
    ])('%j -> %s', (value, expected) => {
        expect(isPlainObject(value)).toBe(expected);
    });
});

describe('COLLECTION_NAME', () => {
    test.each(['items', 'my-items', 'items_2', 'a'])('accepts "%s"', (name) => {
        expect(COLLECTION_NAME.test(name)).toBe(true);
    });

    test.each(['', 'Items', '2items', '-items', '../items', 'it ems'])(
        'rejects "%s"',
        (name) => {
            expect(COLLECTION_NAME.test(name)).toBe(false);
        }
    );
});

describe('isValidId / validateId', () => {
    test('accepts UUIDv7', () => {
        const id = uuidv7();
        expect(isValidId(id)).toBe(true);
        expect(() => validateId(id)).not.toThrow();
    });

    test.each([
        ['UUIDv4', uuidv4()],
        ['random string', 'not-an-id'],
        ['empty string', ''],
        ['number', 42],
        ['null', null],
    ])('rejects %s', (_label, id) => {
        expect(isValidId(id)).toBe(false);
        expect(() => validateId(id)).toThrow(
            expect.objectContaining({ code: 'INVALID_ID', status: 400 })
        );
    });
});

describe('validateConfig', () => {
    const expectInvalid = (name, cfg, message) =>
        expect(() => validateConfig(name, cfg)).toThrow(
            expect.objectContaining({
                code: 'INVALID_CONFIG',
                status: 500,
                ...(message && { message: expect.stringMatching(message) }),
            })
        );

    test('accepts a valid config', () => {
        expect(() =>
            validateConfig(
                'items',
                config({
                    columns: {
                        title: { type: 'string' },
                        count: { type: 'integer' },
                    },
                    indexes: ['title', 'count'],
                })
            )
        ).not.toThrow();
    });

    test('rejects invalid collection name', () => {
        expectInvalid('Items', config({ table: 'Items' }), /collection name/);
    });

    test('rejects table name different from directory', () => {
        expectInvalid('items', config({ table: 'other' }));
    });

    test('rejects primary key other than id', () => {
        expectInvalid('items', config({ primaryKey: 'uuid' }));
    });

    test('rejects non-object config', () => {
        expectInvalid('items', null);
        expectInvalid('items', []);
    });

    test('requires columns object and indexes array', () => {
        expectInvalid('items', config({ columns: [] }), /columns and indexes/);
        expectInvalid('items', config({ indexes: {} }), /columns and indexes/);
    });

    test.each(['1title', 'ti-tle', '_title', 'ti tle'])(
        'rejects column name "%s"',
        (column) => {
            expectInvalid(
                'items',
                config({ columns: { [column]: { type: 'string' } } }),
                /column definition/
            );
        }
    );

    test('rejects non-object column definition', () => {
        expectInvalid(
            'items',
            config({ columns: { title: 'string' } }),
            /column definition/
        );
    });

    test('rejects unknown column type', () => {
        expectInvalid(
            'items',
            config({ columns: { title: { type: 'date' } } }),
            /Invalid type/
        );
    });

    test('rejects "id" column', () => {
        expectInvalid(
            'items',
            config({ columns: { id: { type: 'string' } } }),
            /managed by the file database/
        );
    });

    test('rejects non-string and invalid regex patterns', () => {
        expectInvalid(
            'items',
            config({ columns: { title: { type: 'string', pattern: 1 } } }),
            /Invalid pattern/
        );
        expectInvalid(
            'items',
            config({ columns: { title: { type: 'string', pattern: '(' } } }),
            /Invalid pattern regex/
        );
    });

    test('precompiles valid patterns', () => {
        const cfg = config({
            columns: { code: { type: 'string', pattern: '^[A-Z]+$' } },
        });
        validateConfig('items', cfg);
        expect(cfg.columns.code.compiledPattern).toBeInstanceOf(RegExp);
    });

    test('rejects index on unknown column', () => {
        expectInvalid('items', config({ indexes: ['missing'] }), /index/);
    });

    test('rejects non-string index', () => {
        expectInvalid('items', config({ indexes: [1] }), /index/);
    });

    test.each(['object', 'array'])('rejects index on %s column', (type) => {
        expectInvalid(
            'items',
            config({ columns: { data: { type } }, indexes: ['data'] }),
            /index/
        );
    });
});

describe('validateField', () => {
    const expectError = (value, definition, message) =>
        expect(() => validateField('field', value, definition)).toThrow(
            expect.objectContaining({
                code: 'VALIDATION_ERROR',
                status: 422,
                message: expect.stringMatching(message),
            })
        );

    describe('types', () => {
        test.each([
            ['string', 'text', 1],
            ['number', 1.5, '1.5'],
            ['integer', 2, 2.5],
            ['boolean', false, 0],
            ['object', { a: 1 }, [1]],
            ['array', [1], { 0: 1 }],
        ])('%s accepts valid and rejects invalid values', (type, ok, bad) => {
            expect(() => validateField('field', ok, { type })).not.toThrow();
            expectError(bad, { type }, `"field" must be ${type}`);
        });

        test('number rejects non-finite values', () => {
            expectError(Infinity, { type: 'number' }, /must be number/);
            expectError(NaN, { type: 'number' }, /must be number/);
        });

        test('integer rejects unsafe integers', () => {
            expectError(2 ** 53, { type: 'integer' }, /must be integer/);
        });

        test('unknown type always fails', () => {
            expectError('x', { type: 'date' }, /must be date/);
        });
    });

    describe('nullable', () => {
        test('null is accepted only when nullable', () => {
            expect(() =>
                validateField('field', null, { type: 'string', nullable: true })
            ).not.toThrow();
            expectError(null, { type: 'string' }, /must be string/);
        });

        test('nullable skips other constraints for null', () => {
            expect(() =>
                validateField('field', null, {
                    type: 'string',
                    nullable: true,
                    minLength: 5,
                    enum: ['a'],
                })
            ).not.toThrow();
        });
    });

    describe('constraints', () => {
        test('min / max are inclusive', () => {
            const definition = { type: 'integer', min: 1, max: 10 };
            expect(() => validateField('field', 1, definition)).not.toThrow();
            expect(() => validateField('field', 10, definition)).not.toThrow();
            expectError(0, definition, /at least 1/);
            expectError(11, definition, /at most 10/);
        });

        test('minLength / maxLength are inclusive', () => {
            const definition = { type: 'string', minLength: 2, maxLength: 3 };
            expect(() =>
                validateField('field', 'ab', definition)
            ).not.toThrow();
            expect(() =>
                validateField('field', 'abc', definition)
            ).not.toThrow();
            expectError('a', definition, /too short/);
            expectError('abcd', definition, /too long/);
        });

        test('enum compares with Object.is', () => {
            const definition = { type: 'string', enum: ['a', 'b'] };
            expect(() => validateField('field', 'a', definition)).not.toThrow();
            expectError('c', definition, /one of the configured values/);
        });

        test('pattern uses compiled regex when available', () => {
            const definition = {
                type: 'string',
                pattern: 'ignored',
                compiledPattern: /^\d+$/,
            };
            expect(() =>
                validateField('field', '123', definition)
            ).not.toThrow();
            expectError('ignored', definition, /invalid format/);
        });

        test('pattern compiles on the fly without compiledPattern', () => {
            const definition = { type: 'string', pattern: '^\\d+$' };
            expect(() =>
                validateField('field', '42', definition)
            ).not.toThrow();
            expectError('x42', definition, /invalid format/);
        });
    });
});

describe('normalizeRecord', () => {
    const columns = {
        title: { type: 'string', required: true },
        status: { type: 'string', default: 'new' },
        tags: { type: 'array', default: [] },
        note: { type: 'string' },
    };

    test('rejects unknown fields', () => {
        expect(() =>
            normalizeRecord(columns, { title: 'a', extra: 1 }, true)
        ).toThrow(/Unknown field "extra"/);
    });

    test('applies defaults when creating', () => {
        expect(normalizeRecord(columns, { title: 'a' }, true)).toEqual({
            title: 'a',
            status: 'new',
            tags: [],
        });
    });

    test('does not apply defaults when not creating', () => {
        expect(normalizeRecord(columns, { title: 'a' }, false)).toEqual({
            title: 'a',
        });
    });

    test('default values are cloned per record', () => {
        const first = normalizeRecord(columns, { title: 'a' }, true);
        first.tags.push('mutated');
        const second = normalizeRecord(columns, { title: 'b' }, true);
        expect(second.tags).toEqual([]);
        expect(columns.tags.default).toEqual([]);
    });

    test('explicit values override defaults', () => {
        expect(
            normalizeRecord(columns, { title: 'a', status: 'done' }, true)
                .status
        ).toBe('done');
    });

    test('requires required fields', () => {
        expect(() => normalizeRecord(columns, {}, true)).toThrow(
            /"title" is required/
        );
        expect(() => normalizeRecord(columns, {}, false)).toThrow(
            /"title" is required/
        );
    });

    test('validates every present field', () => {
        expect(() =>
            normalizeRecord(columns, { title: 'a', note: 1 }, true)
        ).toThrow(DatabaseError);
    });

    test('does not mutate the input', () => {
        const input = { title: 'a' };
        normalizeRecord(columns, input, true);
        expect(input).toEqual({ title: 'a' });
    });
});
