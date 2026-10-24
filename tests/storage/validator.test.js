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
            config({ columns: { title: { type: 'timestamp' } } }),
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

    test('does not add anything to the config', () => {
        const cfg = config({
            columns: { code: { type: 'string', pattern: '^[A-Z]+$' } },
        });
        const original = structuredClone(cfg);
        validateConfig('items', cfg);
        expect(cfg).toEqual(original);
    });

    test('rejects index on unknown column', () => {
        expectInvalid('items', config({ indexes: ['missing'] }), /index/);
    });

    test('rejects non-string index', () => {
        expectInvalid('items', config({ indexes: [1] }), /index/);
    });

    test('rejects index on object column', () => {
        expectInvalid(
            'items',
            config({
                columns: { data: { type: 'object' } },
                indexes: ['data'],
            }),
            /index/
        );
    });

    test('accepts index on array column (indexed by element)', () => {
        expect(() =>
            validateConfig(
                'items',
                config({
                    columns: { tags: { type: 'array' } },
                    indexes: ['tags'],
                })
            )
        ).not.toThrow();
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
            expectError('x', { type: 'timestamp' }, /must be timestamp/);
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

        test('pattern works for definitions not passed through validateConfig', () => {
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

describe('validateConfig references', () => {
    const withColumn = (definition) =>
        config({ columns: { title: { type: 'string' }, ref: definition } });
    const expectInvalid = (definition, message) =>
        expect(() => validateConfig('items', withColumn(definition))).toThrow(
            expect.objectContaining({
                code: 'INVALID_CONFIG',
                message: expect.stringMatching(message),
            })
        );
    const expectValid = (definition) =>
        expect(() =>
            validateConfig('items', withColumn(definition))
        ).not.toThrow();

    describe('scalar references', () => {
        test('accepts a reference with default onDelete', () => {
            expectValid({
                type: 'string',
                references: { collection: 'owners' },
            });
        });

        test.each(['restrict', 'setNull'])(
            'accepts onDelete "%s"',
            (onDelete) => {
                expectValid({
                    type: 'string',
                    nullable: true,
                    references: { collection: 'owners', onDelete },
                });
            }
        );

        test('allows referencing its own collection', () => {
            expectValid({
                type: 'string',
                references: { collection: 'items' },
            });
        });

        test.each(['remove', 'cascade', 'nothing'])(
            'rejects onDelete "%s"',
            (onDelete) => {
                expectInvalid(
                    {
                        type: 'string',
                        nullable: true,
                        references: { collection: 'owners', onDelete },
                    },
                    /"onDelete" must be one of: restrict, setNull/
                );
            }
        );

        test('setNull requires a nullable column', () => {
            expectInvalid(
                {
                    type: 'string',
                    references: { collection: 'owners', onDelete: 'setNull' },
                },
                /"setNull" requires a nullable column/
            );
        });

        test('requires a string column', () => {
            expectInvalid(
                { type: 'integer', references: { collection: 'owners' } },
                /requires a string column/
            );
            expectInvalid(
                { type: 'array', references: { collection: 'owners' } },
                /use "items" for arrays/
            );
        });

        test('rejects non-object references', () => {
            expectInvalid(
                { type: 'string', references: 'owners' },
                /must be an object/
            );
        });

        test('rejects invalid collection names', () => {
            expectInvalid(
                { type: 'string', references: { collection: 'Owners' } },
                /valid collection name/
            );
            expectInvalid(
                { type: 'string', references: {} },
                /valid collection name/
            );
        });

        test('rejects unknown options', () => {
            expectInvalid(
                {
                    type: 'string',
                    references: { collection: 'owners', orphan: 'delete' },
                },
                /unknown option "orphan"/
            );
        });

        test('default must be null', () => {
            expectValid({
                type: 'string',
                nullable: true,
                default: null,
                references: { collection: 'owners' },
            });
            expectInvalid(
                {
                    type: 'string',
                    default: 'x',
                    references: { collection: 'owners' },
                },
                /default value must be null/
            );
        });
    });

    describe('array references', () => {
        test('accepts items.references', () => {
            expectValid({
                type: 'array',
                default: [],
                items: { references: { collection: 'tags' } },
            });
        });

        test.each(['restrict', 'remove'])(
            'accepts onDelete "%s"',
            (onDelete) => {
                expectValid({
                    type: 'array',
                    items: { references: { collection: 'tags', onDelete } },
                });
            }
        );

        test('rejects setNull for arrays', () => {
            expectInvalid(
                {
                    type: 'array',
                    items: {
                        references: { collection: 'tags', onDelete: 'setNull' },
                    },
                },
                /"onDelete" must be one of: restrict, remove/
            );
        });

        test('items require an array column', () => {
            expectInvalid(
                {
                    type: 'string',
                    items: { references: { collection: 'tags' } },
                },
                /only allowed for array columns/
            );
        });

        test('items must define references', () => {
            expectInvalid(
                { type: 'array', items: {} },
                /"items" must define "references"/
            );
            expectInvalid(
                { type: 'array', items: 'tags' },
                /"items" must define "references"/
            );
        });

        test('default must be an empty array', () => {
            expectInvalid(
                {
                    type: 'array',
                    default: ['x'],
                    items: { references: { collection: 'tags' } },
                },
                /default value must be an empty array/
            );
        });
    });
});

describe('validateConfig column options', () => {
    const withColumn = (definition) =>
        config({ columns: { field: definition } });
    const expectInvalid = (definition, message) =>
        expect(() => validateConfig('items', withColumn(definition))).toThrow(
            expect.objectContaining({
                code: 'INVALID_CONFIG',
                message: expect.stringMatching(message),
            })
        );
    const expectValid = (definition) =>
        expect(() =>
            validateConfig('items', withColumn(definition))
        ).not.toThrow();

    test('accepts every supported option', () => {
        expectValid({
            type: 'string',
            required: true,
            nullable: true,
            default: 'ABC',
            minLength: 1,
            maxLength: 5,
            enum: ['ABC', 'DEF'],
            pattern: '^[A-Z]+$',
        });
        expectValid({ type: 'integer', min: 0, max: 10, default: 5 });
    });

    test('rejects unknown column options such as typos', () => {
        expectInvalid(
            { type: 'string', requred: true },
            /unknown option "requred"/
        );
    });

    test('rejects unknown top-level options', () => {
        expect(() =>
            validateConfig('items', config({ index: ['title'] }))
        ).toThrow(/Unknown option "index"/);
    });

    test.each(['required', 'nullable'])('"%s" must be a boolean', (flag) => {
        expectInvalid({ type: 'string', [flag]: 'yes' }, /must be a boolean/);
    });

    describe('numeric bounds', () => {
        test.each([
            ['string', { min: 1 }],
            ['boolean', { max: 1 }],
        ])('rejected for %s columns', (type, options) => {
            expectInvalid(
                { type, ...options },
                /requires a numeric, date or datetime column/
            );
        });

        test.each([['10'], [Infinity], [NaN], [null]])(
            'must be finite numbers: %s',
            (value) => {
                expectInvalid(
                    { type: 'number', min: value },
                    /must be a finite number/
                );
            }
        );

        test('min must not exceed max', () => {
            expectInvalid(
                { type: 'integer', min: 5, max: 1 },
                /"min" must not be greater than "max"/
            );
        });
    });

    describe('length bounds', () => {
        test('rejected for non-string columns', () => {
            expectInvalid(
                { type: 'integer', minLength: 1 },
                /requires a string column/
            );
        });

        test.each([[-1], [1.5], ['3']])(
            'must be non-negative integers: %s',
            (value) => {
                expectInvalid(
                    { type: 'string', maxLength: value },
                    /must be a non-negative integer/
                );
            }
        );

        test('minLength must not exceed maxLength', () => {
            expectInvalid(
                { type: 'string', minLength: 5, maxLength: 1 },
                /"minLength" must not be greater than "maxLength"/
            );
        });
    });

    test('pattern requires a string column', () => {
        expectInvalid(
            { type: 'integer', pattern: '^1$' },
            /"pattern" requires a string column/
        );
    });

    describe('enum', () => {
        test.each([[[]], ['a,b'], [{}]])(
            'must be a non-empty array: %j',
            (value) => {
                expectInvalid(
                    { type: 'string', enum: value },
                    /"enum" must be a non-empty array/
                );
            }
        );

        test('values must have the column type', () => {
            expectInvalid(
                { type: 'string', enum: ['a', 1] },
                /every "enum" value must be string/
            );
        });
    });

    describe('default', () => {
        test.each([
            [
                'wrong type',
                { type: 'integer', default: 'five' },
                /must be integer/,
            ],
            [
                'out of range',
                { type: 'integer', max: 30, default: 31 },
                /at most 30/,
            ],
            [
                'not in enum',
                { type: 'string', enum: ['a'], default: 'b' },
                /configured values/,
            ],
            [
                'pattern mismatch',
                { type: 'string', pattern: '^\\d+$', default: 'x' },
                /invalid format/,
            ],
            [
                'null without nullable',
                { type: 'string', default: null },
                /must be string/,
            ],
        ])('rejects a default with %s', (_label, definition, message) => {
            expectInvalid(definition, /Invalid default of "items.field"/);
            expectInvalid(definition, message);
        });

        test('accepts null for nullable columns', () => {
            expectValid({ type: 'string', nullable: true, default: null });
        });
    });
});

describe('validateConfig unique', () => {
    const withColumn = (definition) =>
        config({ columns: { field: definition } });

    test.each(['string', 'number', 'integer', 'boolean'])(
        'accepts unique %s columns',
        (type) => {
            expect(() =>
                validateConfig('items', withColumn({ type, unique: true }))
            ).not.toThrow();
        }
    );

    test.each(['object', 'array'])('rejects unique %s columns', (type) => {
        expect(() =>
            validateConfig('items', withColumn({ type, unique: true }))
        ).toThrow(/"unique" is not supported for/);
    });

    test('unique must be a boolean', () => {
        expect(() =>
            validateConfig('items', withColumn({ type: 'string', unique: 1 }))
        ).toThrow(/"unique" must be a boolean/);
    });
});
