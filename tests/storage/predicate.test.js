import { describe, test, expect } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { RECORDS, createContext, run } from '../helpers/query-fixture.js';
import {
    Predicate,
    AndPredicate,
    OrPredicate,
    eq,
    ne,
    gt,
    gte,
    lt,
    lte,
    range,
    inList,
    and,
    or,
    custom,
    all,
} from '../../src/storage/predicate.js';

function expected(predicate) {
    return RECORDS.filter((r) => predicate.testRecord(r))
        .map((r) => r.id)
        .sort();
}

describe.each([
    ['without indexes', []],
    ['with indexes', ['category', 'price']],
])('Predicate engine %s', (_label, indexedFields) => {
    const evaluate = async (predicate) =>
        (await run(predicate, indexedFields)).ids;

    describe('leaf predicates', () => {
        test('eq matches exact value', async () => {
            expect(await evaluate(eq('category', 'book'))).toEqual(['a', 'b']);
        });

        test('eq on missing value returns nothing', async () => {
            expect(await evaluate(eq('category', 'car'))).toEqual([]);
        });

        test('ne excludes the value', async () => {
            expect(await evaluate(ne('category', 'book'))).toEqual([
                'c',
                'd',
                'e',
            ]);
        });

        test('gt / gte / lt / lte respect bound inclusivity', async () => {
            expect(await evaluate(gt('price', 25))).toEqual(['d']);
            expect(await evaluate(gte('price', 25))).toEqual(['b', 'd', 'e']);
            expect(await evaluate(lt('price', 10))).toEqual(['c']);
            expect(await evaluate(lte('price', 10))).toEqual(['a', 'c']);
        });

        test('range combines lower and upper bounds', async () => {
            expect(await evaluate(range('price', { gt: 5, lte: 25 }))).toEqual([
                'a',
                'b',
                'e',
            ]);
        });

        test('inList matches any of the values', async () => {
            expect(await evaluate(inList('category', ['toy', 'food']))).toEqual(
                ['c', 'd', 'e']
            );
        });

        test('inList with a single non-array value', async () => {
            expect(await evaluate(inList('category', 'food'))).toEqual(['e']);
        });

        test('custom uses the given function', async () => {
            expect(await evaluate(custom((r) => r.price % 10 === 5))).toEqual([
                'b',
                'c',
                'e',
            ]);
        });

        test('all returns every record', async () => {
            expect(await evaluate(all())).toEqual(['a', 'b', 'c', 'd', 'e']);
        });

        test('eq / inList on id use the primary key', async () => {
            expect(await evaluate(eq('id', 'c'))).toEqual(['c']);
            expect(await evaluate(inList('id', ['a', 'e', 'zz']))).toEqual([
                'a',
                'e',
            ]);
        });
    });

    describe('composite predicates', () => {
        test('and intersects conditions', async () => {
            expect(
                await evaluate(and(eq('category', 'book'), gt('price', 15)))
            ).toEqual(['b']);
        });

        test('or unites conditions', async () => {
            expect(
                await evaluate(or(eq('category', 'food'), lt('price', 10)))
            ).toEqual(['c', 'e']);
        });

        test('and with nested or applies the or condition', async () => {
            // category = book AND (price = 5 OR price = 40) -> nothing
            const predicate = and(
                eq('category', 'book'),
                or(eq('price', 5), eq('price', 40))
            );
            expect(await evaluate(predicate)).toEqual([]);
        });

        test('and with nested or keeps matching records', async () => {
            // inStock AND (category = toy OR price = 25)
            const predicate = and(
                eq('inStock', true),
                or(eq('category', 'toy'), eq('price', 25))
            );
            expect(await evaluate(predicate)).toEqual(['c', 'e']);
        });

        test('and with nested and applies all conditions', async () => {
            const predicate = and(
                eq('inStock', true),
                and(gte('price', 10), ne('category', 'food'))
            );
            expect(await evaluate(predicate)).toEqual(['a']);
        });

        test('or with nested and branches', async () => {
            const predicate = or(
                and(eq('category', 'book'), eq('inStock', false)),
                and(eq('category', 'toy'), eq('inStock', true))
            );
            expect(await evaluate(predicate)).toEqual(['b', 'c']);
        });

        test('or with nested or', async () => {
            const predicate = or(
                eq('category', 'food'),
                or(eq('price', 5), eq('price', 40))
            );
            expect(await evaluate(predicate)).toEqual(['c', 'd', 'e']);
        });

        test('deeply nested predicates', async () => {
            // (book OR toy) AND NOT(price = 10) AND (inStock OR price > 30)
            const predicate = and(
                or(eq('category', 'book'), eq('category', 'toy')),
                ne('price', 10),
                or(
                    eq('inStock', true),
                    and(
                        gt('price', 30),
                        custom(() => true)
                    )
                )
            );
            expect(await evaluate(predicate)).toEqual(['c', 'd']);
        });

        test('and() without predicates returns every record', async () => {
            expect(await evaluate(and())).toEqual(['a', 'b', 'c', 'd', 'e']);
        });

        test('or() without predicates returns nothing', async () => {
            expect(await evaluate(or())).toEqual([]);
        });

        test('add() appends a predicate to and', async () => {
            const predicate = and(eq('category', 'toy')).add(gt('price', 10));
            expect(await evaluate(predicate)).toEqual(['d']);
        });
    });

    describe('evaluate agrees with testRecord', () => {
        const cases = [
            and(
                eq('category', 'book'),
                or(eq('price', 25), eq('inStock', true))
            ),
            or(and(gt('price', 5), lt('price', 30)), eq('category', 'toy')),
            and(or(), eq('category', 'book')),
            or(and(), eq('category', 'book')),
            and(
                inList('category', ['book', 'toy']),
                or(
                    gte('price', 40),
                    custom((r) => r.inStock)
                )
            ),
            or(
                and(eq('category', 'food'), and(eq('price', 25))),
                ne('inStock', true)
            ),
        ];

        test.each(cases.map((p, i) => [i, p]))(
            'case #%i',
            async (_i, predicate) => {
                expect(await evaluate(predicate)).toEqual(expected(predicate));
            }
        );
    });
});

describe('Predicate engine index usage', () => {
    const indexed = ['category', 'price'];

    test('indexed eq does not read records', async () => {
        const { ids, reads } = await run(eq('category', 'toy'), indexed);
        expect(ids).toEqual(['c', 'd']);
        expect(reads).toEqual([]);
    });

    test('unindexed eq scans every record', async () => {
        const { reads } = await run(eq('inStock', true), indexed);
        expect(reads.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    test('and reads only records narrowed by index', async () => {
        const { ids, reads } = await run(
            and(eq('category', 'book'), eq('inStock', true)),
            indexed
        );
        expect(ids).toEqual(['a']);
        expect(reads.sort()).toEqual(['a', 'b']);
    });

    test('and with nested indexed or is resolved fully by index', async () => {
        const { ids, reads } = await run(
            and(
                gte('price', 10),
                or(eq('category', 'toy'), eq('category', 'food'))
            ),
            indexed
        );
        expect(ids).toEqual(['d', 'e']);
        expect(reads).toEqual([]);
    });

    test('nested or narrows candidates before reading the rest', async () => {
        const { ids, reads } = await run(
            and(
                or(eq('category', 'book'), eq('price', 5)),
                eq('inStock', true)
            ),
            indexed
        );
        expect(ids).toEqual(['a', 'c']);
        expect(reads.sort()).toEqual(['a', 'b', 'c']);
    });

    test('or with an unindexed branch falls back to a full scan', async () => {
        const { ids, reads } = await run(
            or(eq('category', 'food'), eq('inStock', false)),
            indexed
        );
        expect(ids).toEqual(['b', 'd', 'e']);
        expect(reads.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    test('nested and narrows by its indexed part', async () => {
        const { ids, reads } = await run(
            and(
                eq('inStock', false),
                and(
                    eq('category', 'toy'),
                    custom((r) => r.price > 1)
                )
            ),
            indexed
        );
        expect(ids).toEqual(['d']);
        expect(reads.sort()).toEqual(['c', 'd']);
    });

    test('evaluate respects explicit candidate ids', async () => {
        const { context } = createContext(indexed);
        const result = await or(
            eq('category', 'book'),
            eq('category', 'toy')
        ).evaluate(context, new Set(['b', 'c', 'e']));
        expect([...result].sort()).toEqual(['b', 'c']);
    });

    test('composite predicates report index capabilities', () => {
        const { context } = createContext(indexed);
        const indexedOr = or(eq('category', 'toy'), lt('price', 10));
        const mixedOr = or(eq('category', 'toy'), eq('inStock', true));
        const mixedAnd = and(eq('category', 'toy'), eq('inStock', true));

        expect(indexedOr.canUseIndex(context)).toBe(true);
        expect(indexedOr.isFullyResolvedByIndex(context)).toBe(true);
        expect(mixedOr.canUseIndex(context)).toBe(false);
        expect(mixedAnd.canUseIndex(context)).toBe(true);
        expect(mixedAnd.isFullyResolvedByIndex(context)).toBe(false);
    });
});

describe('custom predicate', () => {
    test('rejects async functions instead of matching everything', async () => {
        const predicate = custom(async (r) => r.price > 1000);
        await expect(run(predicate)).rejects.toThrow(
            /must be synchronous.*not a Promise/
        );
    });

    test('rejects functions returning thenables', () => {
        const predicate = custom(() => ({ then() {} }));
        expect(() => predicate.testRecord({})).toThrow(TypeError);
    });

    test('requires a function', () => {
        expect(() => custom('price > 10')).toThrow(
            'custom() expects a function.'
        );
    });

    test('truthy and falsy results are converted to booleans', () => {
        expect(custom(() => 1).testRecord({})).toBe(true);
        expect(custom(() => 0).testRecord({})).toBe(false);
        expect(custom(() => null).testRecord({})).toBe(false);
    });
});

describe('Predicate contract', () => {
    test('subclass without testRecord throws instead of matching everything', () => {
        class Incomplete extends Predicate {}
        expect(() => new Incomplete().testRecord({})).toThrow(
            /must implement testRecord/
        );
    });

    test('factories build expected classes', () => {
        expect(and()).toBeInstanceOf(AndPredicate);
        expect(or()).toBeInstanceOf(OrPredicate);
    });
});

describe.each([
    ['without indexes', []],
    ['with indexes', ['price']],
])('Range predicates over null and mixed types %s', (_label, indexedFields) => {
    const records = [
        { id: 'p', price: 3 },
        { id: 'q', price: 20 },
        { id: 'n', price: null },
        { id: 'm' },
        { id: 's', price: '10' },
    ];
    const evaluate = async (predicate) =>
        (await run(predicate, indexedFields, records)).ids;

    test('null and missing values never match a numeric range', async () => {
        expect(await evaluate(lt('price', 10))).toEqual(['p']);
        expect(await evaluate(lte('price', 0))).toEqual([]);
        expect(await evaluate(gte('price', 0))).toEqual(['p', 'q']);
    });

    test('values of another type are not coerced', async () => {
        // '10' would be coerced to 10 by JS comparison operators
        expect(await evaluate(range('price', { gt: 5, lt: 15 }))).toEqual([]);
    });

    test('string bounds compare only string values', async () => {
        expect(await evaluate(gt('price', '0'))).toEqual(['s']);
    });

    test('null bound is rejected when the predicate is built', () => {
        expect(() => lt('price', null)).toThrow(TypeError);
        expect(() => gte('price', null)).toThrow(TypeError);
    });

    test('eq still matches null explicitly', async () => {
        expect(await evaluate(eq('price', null))).toEqual(['n']);
    });
});

describe('values a predicate may compare with', () => {
    const NOT_JSON = [
        ['undefined', undefined],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['BigInt', 10n],
        ['symbol', Symbol('x')],
        ['function', () => 1],
        ['Date', new Date()],
        ['Map', new Map()],
    ];

    test.each(NOT_JSON)('eq/ne/inList reject %s', (_label, value) => {
        expect(() => eq('price', value)).toThrow(TypeError);
        expect(() => ne('price', value)).toThrow(TypeError);
        expect(() => inList('price', [1, value])).toThrow(TypeError);
    });

    test.each([
        ['string', 'x'],
        ['number', 1.5],
        ['boolean', false],
        ['null', null],
        ['object', { a: 1 }],
        ['array', [1, 2]],
        ['object without prototype', Object.create(null)],
    ])('eq accepts %s', (_label, value) => {
        expect(() => eq('price', value)).not.toThrow();
    });

    test('the error explains what is allowed', () => {
        expect(() => eq('price', undefined)).toThrow(
            /eq\(\) cannot compare with undefined: records only hold strings, finite numbers/
        );
    });

    test.each([
        ['undefined', undefined],
        ['empty string', ''],
        ['number', 1],
    ])('rejects %s as a field name', (_label, field) => {
        expect(() => eq(field, 1)).toThrow(/field must be a non-empty string/);
    });

    describe('range bounds', () => {
        test('accept numbers, strings and infinite numbers', async () => {
            expect(
                (await run(range('price', { gt: -Infinity, lt: Infinity }))).ids
            ).toEqual(['a', 'b', 'c', 'd', 'e']);
            expect(() => gt('category', 'a')).not.toThrow();
        });

        test.each([
            ['NaN', NaN],
            ['boolean', true],
            ['object', {}],
            ['BigInt', 1n],
        ])('reject %s', (_label, value) => {
            expect(() => gt('price', value)).toThrow(TypeError);
        });

        test('reject unknown bounds and non-object ranges', () => {
            expect(() => range('price', { gt: 1, above: 2 })).toThrow(
                /Unknown range bound "above"/
            );
            expect(() => range('price', 5)).toThrow(TypeError);
        });

        test('ignore undefined bounds', async () => {
            expect(
                (await run(range('price', { gt: 20, lt: undefined }))).ids
            ).toEqual(['b', 'd', 'e']);
        });
    });

    describe('with and without an index the result is the same', () => {
        const records = [
            { id: 'a', price: 0 },
            { id: 'b', price: -0 },
            { id: 'c', price: 1 },
            { id: 'd', price: null },
        ];
        const both = async (predicate) => [
            (await run(predicate, [], records)).ids,
            (await run(predicate, ['price'], records)).ids,
        ];

        test('-0 and 0 are the same value', async () => {
            const [plain, indexed] = await both(eq('price', -0));
            expect(plain).toEqual(['a', 'b']);
            expect(indexed).toEqual(plain);
        });

        test('ne and inList agree as well', async () => {
            const [plainNe, indexedNe] = await both(ne('price', 0));
            expect(plainNe).toEqual(['c', 'd']);
            expect(indexedNe).toEqual(plainNe);
            const [plainIn, indexedIn] = await both(inList('price', [-0, 1]));
            expect(plainIn).toEqual(['a', 'b', 'c']);
            expect(indexedIn).toEqual(plainIn);
        });
    });
});

describe('prepare checks fields against the columns', () => {
    const COLUMNS = {
        name: { type: 'string' },
        age: { type: 'integer' },
        settings: { type: 'object' },
    };
    const unknownField = { code: 'INVALID_QUERY', status: 400 };

    test.each([
        ['eq', eq('nmae', 'Оля')],
        ['ne', ne('nmae', 'Оля')],
        ['inList', inList('nmae', ['Оля'])],
        ['range', range('aeg', { gte: 3 })],
        ['gt', gt('aeg', 3)],
        ['lte', lte('aeg', 3)],
    ])('%s on an unknown field is rejected', (_label, predicate) => {
        expect(() => predicate.prepare(COLUMNS)).toThrow(
            /Unknown filter field "(nmae|aeg)"/
        );
        expect(() => predicate.prepare(COLUMNS)).toThrowError(
            expect.objectContaining(unknownField)
        );
    });

    test('a path into an object column is not a column', () => {
        expect(() => eq('settings.theme', 'dark').prepare(COLUMNS)).toThrow(
            'Unknown filter field "settings.theme".'
        );
    });

    test('an unknown field deep inside and/or is rejected', () => {
        const predicate = and(
            eq('name', 'Оля'),
            or(gte('age', 3), and(ne('typo', 1)))
        );
        expect(() => predicate.prepare(COLUMNS)).toThrow(
            'Unknown filter field "typo".'
        );
    });

    test('columns and id pass, and nothing changes', () => {
        const predicates = [
            eq('name', 'Оля'),
            ne('age', 3),
            inList('id', [uuidv7()]),
            range('age', { gte: 3, lt: 5 }),
            eq('settings', { theme: 'dark' }),
        ];
        for (const predicate of predicates) {
            expect(predicate.prepare(COLUMNS)).toBe(predicate);
        }
        const composite = and(eq('name', 'Оля'), or(gt('id', 'a')));
        expect(composite.prepare(COLUMNS).predicates[0]).toBe(
            composite.predicates[0]
        );
    });

    test('managed timestamps are fields only when they are among the columns', () => {
        const withTimestamps = {
            ...COLUMNS,
            createdAt: { type: 'datetime' },
        };
        expect(() =>
            gte('createdAt', '2026-10-01T00:00:00.000Z').prepare(withTimestamps)
        ).not.toThrow();
        expect(() =>
            gte('createdAt', '2026-10-01T00:00:00.000Z').prepare(COLUMNS)
        ).toThrow('Unknown filter field "createdAt".');
    });

    test('custom and all have no field to check', () => {
        const anything = custom((record) => record.whatever === 1);
        expect(anything.prepare(COLUMNS)).toBe(anything);
        expect(all().prepare(COLUMNS)).toBeInstanceOf(Predicate);
    });
});

describe('prepare checks values against the columns', () => {
    const COLUMNS = {
        name: { type: 'string', pattern: '^[А-ЯҐЄІЇ]' },
        age: { type: 'integer', min: 1, max: 5 },
        price: { type: 'number' },
        rating: { type: 'integer', nullable: true },
        status: { type: 'string', enum: ['new', 'done'] },
        active: { type: 'boolean' },
        settings: { type: 'object' },
        paidAt: { type: 'datetime' },
    };
    const invalid = (message) =>
        expect.objectContaining({
            code: 'INVALID_QUERY',
            status: 400,
            message,
        });

    describe('eq and inList are checked fully', () => {
        test.each([
            [eq('age', '3'), '"age" must be integer.'],
            [eq('age', 2.5), '"age" must be integer.'],
            [eq('age', 7), '"age" must be at most 5.'],
            [
                eq('status', 'old'),
                '"status" must be one of the configured values.',
            ],
            [eq('name', 'olia'), '"name" has an invalid format.'],
            [eq('name', null), '"name" must be string.'],
            [inList('age', [3, '4']), '"age" must be integer.'],
            [
                inList('status', ['new', 'old']),
                '"status" must be one of the configured values.',
            ],
        ])('%o is rejected', (predicate, message) => {
            expect(() => predicate.prepare(COLUMNS)).toThrowError(
                invalid(message)
            );
        });

        test('values the column can hold pass', () => {
            for (const predicate of [
                eq('age', 3),
                eq('rating', null),
                eq('settings', { theme: 'dark' }),
                inList('status', ['new', 'done']),
                inList('age', []),
            ]) {
                expect(predicate.prepare(COLUMNS)).toBe(predicate);
            }
        });
    });

    describe('ne and range bounds are checked by type only', () => {
        test('values outside min/max, enum or pattern pass', () => {
            for (const predicate of [
                ne('age', 99),
                ne('age', 2.5),
                ne('status', 'old'),
                gt('age', 2.5),
                lt('age', 10),
                range('name', { gte: 'a', lt: 'z' }),
                gte('price', -Infinity),
                lt('age', Infinity),
            ]) {
                expect(predicate.prepare(COLUMNS)).toBe(predicate);
            }
        });

        test.each([
            [ne('age', '3'), '"age" must be number.'],
            [ne('active', 1), '"active" must be boolean.'],
            [ne('age', null), '"age" must be number.'],
            [gt('age', '3'), '"age" must be number.'],
            [lt('name', 3), '"name" must be string.'],
            [lt('name', Infinity), '"name" must be string.'],
            [
                gte('paidAt', '2026-10-01'),
                expect.stringMatching(/^"paidAt" must be datetime/),
            ],
        ])('%o is rejected', (predicate, message) => {
            expect(() => predicate.prepare(COLUMNS)).toThrowError(
                invalid(message)
            );
        });

        test.each([
            ['active', 'boolean'],
            ['settings', 'object'],
        ])('ranges on %s (%s) are rejected', (field, type) => {
            expect(() => gt(field, 1).prepare(COLUMNS)).toThrowError(
                invalid(
                    `Range operators are not supported for "${field}" (${type}).`
                )
            );
        });
    });

    describe('id', () => {
        test('eq and inList need UUIDv7 ids', () => {
            for (const predicate of [
                eq('id', 'abc'),
                inList('id', [uuidv7(), 'abc']),
            ]) {
                expect(() => predicate.prepare(COLUMNS)).toThrowError(
                    expect.objectContaining({ code: 'INVALID_ID', status: 400 })
                );
            }
        });

        test('ne and ranges compare ids as strings', () => {
            for (const predicate of [ne('id', 'abc'), gte('id', '0')]) {
                expect(predicate.prepare(COLUMNS)).toBe(predicate);
            }
            expect(() => gt('id', 5).prepare(COLUMNS)).toThrowError(
                invalid('"id" must be string.')
            );
        });
    });

    test('datetime values are normalized into a new predicate', () => {
        const original = gte('paidAt', '2026-10-01T00:00+03:00');
        const prepared = original.prepare(COLUMNS);
        expect(prepared.range).toEqual({ gte: '2026-09-30T21:00:00.000Z' });
        expect(original.range).toEqual({ gte: '2026-10-01T00:00+03:00' });
    });

    test('a wrong value deep inside and/or is rejected', () => {
        const predicate = or(eq('age', 3), and(gt('price', 1), eq('age', 9)));
        expect(() => predicate.prepare(COLUMNS)).toThrowError(
            invalid('"age" must be at most 5.')
        );
    });
});
