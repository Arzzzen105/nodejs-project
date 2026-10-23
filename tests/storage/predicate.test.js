import { describe, test, expect } from 'vitest';
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

    test('null bound matches nothing', async () => {
        expect(await evaluate(lt('price', null))).toEqual([]);
        expect(await evaluate(gte('price', null))).toEqual([]);
    });

    test('eq still matches null explicitly', async () => {
        expect(await evaluate(eq('price', null))).toEqual(['n']);
    });
});
