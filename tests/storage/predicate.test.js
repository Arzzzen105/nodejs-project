import { describe, test, expect } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { IndexManager } from '../../src/storage/index-manager.js';
import { QueryContext } from '../../src/storage/query-context.js';
import { DatabaseError } from '../../src/storage/errors.js';
import { validateField, validateId } from '../../src/storage/validator.js';
import {
    Predicate,
    AndPredicate,
    EqPredicate,
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

const RECORDS = [
    { id: 'a', category: 'book', price: 10, inStock: true },
    { id: 'b', category: 'book', price: 25, inStock: false },
    { id: 'c', category: 'toy', price: 5, inStock: true },
    { id: 'd', category: 'toy', price: 40, inStock: false },
    { id: 'e', category: 'food', price: 25, inStock: true },
];

/**
 * Builds a QueryContext over an in-memory collection backed by a real IndexManager.
 * `reads` collects ids of records loaded through the context (i.e. not resolved by index).
 */
function createContext(indexedFields = [], records = RECORDS) {
    const indexes = new IndexManager(indexedFields);
    const byId = new Map();
    for (const record of records) {
        byId.set(record.id, record);
        indexes.indexRecord(record);
    }

    const reads = [];
    const collection = {
        name: 'products',
        config: { columns: {} },
        records: new Set(byId.keys()),
        hasIndex: (field) => indexes.hasIndex(field),
        lookupIndex: (field, value) => indexes.lookup(field, value),
        lookupInIndex: (field, values) => indexes.lookupIn(field, values),
        lookupRangeIndex: (field, bounds) => indexes.lookupRange(field, bounds),
        readRecord: async (id) => {
            reads.push(id);
            return byId.get(id);
        },
    };

    return { context: new QueryContext(collection), reads };
}

async function run(predicate, indexedFields = [], records = RECORDS) {
    const { context, reads } = createContext(indexedFields, records);
    const ids = [...(await predicate.evaluate(context))].sort();
    return { ids, reads };
}

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

describe('Predicate.fromWhere', () => {
    const columns = {
        category: { type: 'string' },
        price: { type: 'integer', min: 0, max: 100 },
        rating: { type: 'integer', nullable: true },
        code: { type: 'string', pattern: '^[A-Z]{3}$' },
        status: { type: 'string', enum: ['new', 'done'] },
        active: { type: 'boolean' },
        meta: { type: 'object' },
    };
    const fromWhere = (where) =>
        Predicate.fromWhere(
            where,
            columns,
            validateField,
            DatabaseError,
            validateId
        );

    test('empty where returns all()', async () => {
        expect((await run(fromWhere({}))).ids).toEqual([
            'a',
            'b',
            'c',
            'd',
            'e',
        ]);
    });

    test('builds an and chain from fields and operators', async () => {
        const predicate = fromWhere({
            category: { in: ['book', 'food'] },
            price: { gte: 20, lt: 30 },
        });
        expect(predicate).toBeInstanceOf(AndPredicate);
        expect((await run(predicate)).ids).toEqual(['b', 'e']);
    });

    test('rejects unknown fields', () => {
        expect(() => fromWhere({ color: 'red' })).toThrow(DatabaseError);
    });

    test('rejects non-array IN filter', () => {
        expect(() => fromWhere({ category: { in: 'book' } })).toThrow(
            /must be an array/
        );
    });

    test('validates operator values against the schema', () => {
        expect(() => fromWhere({ price: { gt: 'cheap' } })).toThrow(
            /must be number/
        );
        expect(() => fromWhere({ price: { eq: 1.5 } })).toThrow(
            /must be integer/
        );
    });

    test('rejects a non-object where', () => {
        expect(() => fromWhere([])).toThrow(/"where" must be a JSON object/);
    });

    describe('id filters', () => {
        const id = uuidv7();

        test('accepts direct value, eq and in', () => {
            expect(() => fromWhere({ id })).not.toThrow();
            expect(() => fromWhere({ id: { eq: id } })).not.toThrow();
            expect(() => fromWhere({ id: { in: [id] } })).not.toThrow();
        });

        test.each(['ne', 'gt', 'gte', 'lt', 'lte', 'foo'])(
            'rejects "%s" operator instead of matching everything',
            (op) => {
                expect(() => fromWhere({ id: { [op]: id } })).toThrow(
                    new RegExp(`Unsupported operator "${op}" for "id"`)
                );
            }
        );

        test('rejects an unsupported operator next to a supported one', () => {
            expect(() => fromWhere({ id: { eq: id, ne: id } })).toThrow(
                /Unsupported operator "ne"/
            );
        });

        test('rejects an empty operator object', () => {
            expect(() => fromWhere({ id: {} })).toThrow(
                /at least one operator/
            );
        });

        test('errors are INVALID_QUERY with status 400', () => {
            try {
                fromWhere({ id: { gt: id } });
                expect.unreachable();
            } catch (error) {
                expect(error).toBeInstanceOf(DatabaseError);
                expect(error.status).toBe(400);
                expect(error.code).toBe('INVALID_QUERY');
            }
        });
    });

    describe('operator objects', () => {
        test('rejects unknown operators mixed with known ones', () => {
            expect(() => fromWhere({ price: { gt: 5, foo: 1 } })).toThrow(
                /Unsupported operator "foo" for "price"/
            );
        });

        test('rejects a misspelled operator', () => {
            expect(() => fromWhere({ price: { eqq: 5 } })).toThrow(
                /Unsupported operator "eqq"/
            );
        });

        test('rejects an empty operator object', () => {
            expect(() => fromWhere({ price: {} })).toThrow(
                /at least one operator/
            );
        });

        test('rejects range operators on non-orderable columns', () => {
            expect(() => fromWhere({ active: { gt: false } })).toThrow(
                /Range operators are not supported for "active"/
            );
        });

        test('rejects null range bounds', () => {
            expect(() => fromWhere({ rating: { lt: null } })).toThrow(
                /"rating" lt bound cannot be null/
            );
        });

        test('allows eq null on nullable columns', () => {
            expect(() => fromWhere({ rating: { eq: null } })).not.toThrow();
            expect(() => fromWhere({ rating: null })).not.toThrow();
        });
    });

    describe('value validation', () => {
        test('range bounds may lie outside min/max', async () => {
            expect(() => fromWhere({ price: { lt: 101 } })).not.toThrow();
            expect(() => fromWhere({ price: { gt: -1 } })).not.toThrow();
            const predicate = fromWhere({ price: { gte: -5, lte: 1000 } });
            expect((await run(predicate)).ids).toEqual([
                'a',
                'b',
                'c',
                'd',
                'e',
            ]);
        });

        test('range bounds ignore pattern and enum', () => {
            expect(() => fromWhere({ code: { gte: 'A' } })).not.toThrow();
            expect(() => fromWhere({ status: { lt: 'm' } })).not.toThrow();
        });

        test('range bounds must still have the column type', () => {
            expect(() => fromWhere({ price: { lt: '5' } })).toThrow(
                /"price" must be number/
            );
            expect(() => fromWhere({ category: { gt: 1 } })).toThrow(
                /"category" must be string/
            );
        });

        test('integer columns accept fractional range bounds', async () => {
            const predicate = fromWhere({ price: { gt: 9.5, lt: 25.5 } });
            expect((await run(predicate)).ids).toEqual(['a', 'b', 'e']);
        });

        test('ne accepts values outside constraints', () => {
            expect(() => fromWhere({ price: { ne: 101 } })).not.toThrow();
            expect(() =>
                fromWhere({ status: { ne: 'archived' } })
            ).not.toThrow();
            expect(() => fromWhere({ code: { ne: 'abc' } })).not.toThrow();
        });

        test('ne still checks type and nullability', () => {
            expect(() => fromWhere({ price: { ne: 'x' } })).toThrow(
                /"price" must be number/
            );
            expect(() => fromWhere({ rating: { ne: null } })).not.toThrow();
            expect(() => fromWhere({ price: { ne: null } })).toThrow(
                /"price" must be number/
            );
        });

        test('eq and in are validated against all constraints', () => {
            expect(() => fromWhere({ price: { eq: 101 } })).toThrow(
                /at most 100/
            );
            expect(() => fromWhere({ price: 101 })).toThrow(/at most 100/);
            expect(() =>
                fromWhere({ status: { in: ['new', 'archived'] } })
            ).toThrow(/one of the configured values/);
            expect(() => fromWhere({ code: 'abc' })).toThrow(/invalid format/);
        });
    });

    describe('object columns', () => {
        test('plain object without operators means equality', () => {
            const predicate = fromWhere({ meta: { color: 'red' } });
            expect(predicate.predicates[0]).toBeInstanceOf(EqPredicate);
            expect(predicate.predicates[0].value).toEqual({ color: 'red' });
        });

        test('eq operator compares the whole object', () => {
            const predicate = fromWhere({ meta: { eq: { eq: 1 } } });
            expect(predicate.predicates[0].value).toEqual({ eq: 1 });
        });

        test('rejects operators mixed with plain keys', () => {
            expect(() =>
                fromWhere({ meta: { eq: { a: 1 }, color: 'red' } })
            ).toThrow(/Unsupported operator "color"/);
        });
    });
});
