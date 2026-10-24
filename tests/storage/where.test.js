import { describe, test, expect } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { DatabaseError } from '../../src/storage/errors.js';
import {
    AndPredicate,
    EqPredicate,
    eq,
    gt,
    contains,
    inList,
    lt,
    ne,
} from '../../src/storage/predicate.js';
import { parseWhere } from '../../src/storage/where.js';
import { run } from '../helpers/query-fixture.js';

describe('parseWhere', () => {
    const columns = {
        category: { type: 'string' },
        price: { type: 'integer', min: 0, max: 100 },
        rating: { type: 'integer', nullable: true },
        code: { type: 'string', pattern: '^[A-Z]{3}$' },
        status: { type: 'string', enum: ['new', 'done'] },
        active: { type: 'boolean' },
        meta: { type: 'object' },
    };
    const parse = (where) => parseWhere(where, columns);

    test('empty where returns all()', async () => {
        expect((await run(parse({}))).ids).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    test('builds an and chain from fields and operators', async () => {
        const predicate = parse({
            category: { in: ['book', 'food'] },
            price: { gte: 20, lt: 30 },
        });
        expect(predicate).toBeInstanceOf(AndPredicate);
        expect((await run(predicate)).ids).toEqual(['b', 'e']);
    });

    test('rejects unknown fields', () => {
        expect(() => parse({ color: 'red' })).toThrow(DatabaseError);
    });

    test('rejects non-array IN filter', () => {
        expect(() => parse({ category: { in: 'book' } })).toThrow(
            /must be an array/
        );
    });

    test('validates operator values against the schema', () => {
        expect(() => parse({ price: { gt: 'cheap' } })).toThrow(
            /must be number/
        );
        expect(() => parse({ price: { eq: 1.5 } })).toThrow(/must be integer/);
    });

    test('rejects a non-object where', () => {
        expect(() => parse([])).toThrow(/"where" must be a JSON object/);
    });

    describe('id filters', () => {
        const id = uuidv7();

        test('accepts direct value, eq and in', () => {
            expect(() => parse({ id })).not.toThrow();
            expect(() => parse({ id: { eq: id } })).not.toThrow();
            expect(() => parse({ id: { in: [id] } })).not.toThrow();
        });

        test.each(['ne', 'gt', 'gte', 'lt', 'lte', 'foo'])(
            'rejects "%s" operator instead of matching everything',
            (op) => {
                expect(() => parse({ id: { [op]: id } })).toThrow(
                    new RegExp(`Unsupported operator "${op}" for "id"`)
                );
            }
        );

        test('rejects an unsupported operator next to a supported one', () => {
            expect(() => parse({ id: { eq: id, ne: id } })).toThrow(
                /Unsupported operator "ne"/
            );
        });

        test('rejects an empty operator object', () => {
            expect(() => parse({ id: {} })).toThrow(/at least one operator/);
        });

        test('errors are INVALID_QUERY with status 400', () => {
            try {
                parse({ id: { gt: id } });
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
            expect(() => parse({ price: { gt: 5, foo: 1 } })).toThrow(
                /Unsupported operator "foo" for "price"/
            );
        });

        test('rejects a misspelled operator', () => {
            expect(() => parse({ price: { eqq: 5 } })).toThrow(
                /Unsupported operator "eqq"/
            );
        });

        test('rejects an empty operator object', () => {
            expect(() => parse({ price: {} })).toThrow(/at least one operator/);
        });

        test('rejects range operators on non-orderable columns', () => {
            expect(() => parse({ active: { gt: 1 } })).toThrow(
                /Range operators are not supported for "active" \(boolean\)/
            );
        });

        test('rejects range bounds that are neither numbers nor strings', () => {
            expect(() => parse({ price: { gt: true } })).toThrowError(
                expect.objectContaining({
                    code: 'INVALID_QUERY',
                    message: '"price" gt bound must be a number or a string.',
                })
            );
            expect(() => parse({ price: { lte: [1] } })).toThrow(
                /"price" lte bound must be a number or a string/
            );
        });

        test('rejects null range bounds', () => {
            expect(() => parse({ rating: { lt: null } })).toThrow(
                /"rating" lt bound cannot be null/
            );
        });

        test('allows eq null on nullable columns', () => {
            expect(() => parse({ rating: { eq: null } })).not.toThrow();
            expect(() => parse({ rating: null })).not.toThrow();
        });
    });

    describe('value validation', () => {
        test('range bounds may lie outside min/max', async () => {
            expect(() => parse({ price: { lt: 101 } })).not.toThrow();
            expect(() => parse({ price: { gt: -1 } })).not.toThrow();
            const predicate = parse({ price: { gte: -5, lte: 1000 } });
            expect((await run(predicate)).ids).toEqual([
                'a',
                'b',
                'c',
                'd',
                'e',
            ]);
        });

        test('range bounds ignore pattern and enum', () => {
            expect(() => parse({ code: { gte: 'A' } })).not.toThrow();
            expect(() => parse({ status: { lt: 'm' } })).not.toThrow();
        });

        test('range bounds must still have the column type', () => {
            expect(() => parse({ price: { lt: '5' } })).toThrow(
                /"price" must be number/
            );
            expect(() => parse({ category: { gt: 1 } })).toThrow(
                /"category" must be string/
            );
        });

        test('integer columns accept fractional range bounds', async () => {
            const predicate = parse({ price: { gt: 9.5, lt: 25.5 } });
            expect((await run(predicate)).ids).toEqual(['a', 'b', 'e']);
        });

        test('ne accepts values outside constraints', () => {
            expect(() => parse({ price: { ne: 101 } })).not.toThrow();
            expect(() => parse({ status: { ne: 'archived' } })).not.toThrow();
            expect(() => parse({ code: { ne: 'abc' } })).not.toThrow();
        });

        test('ne still checks type and nullability', () => {
            expect(() => parse({ price: { ne: 'x' } })).toThrow(
                /"price" must be number/
            );
            expect(() => parse({ rating: { ne: null } })).not.toThrow();
            expect(() => parse({ price: { ne: null } })).toThrow(
                /"price" must be number/
            );
        });

        test('eq and in are validated against all constraints', () => {
            expect(() => parse({ price: { eq: 101 } })).toThrow(/at most 100/);
            expect(() => parse({ price: 101 })).toThrow(/at most 100/);
            expect(() =>
                parse({ status: { in: ['new', 'archived'] } })
            ).toThrow(/one of the configured values/);
            expect(() => parse({ code: 'abc' })).toThrow(/invalid format/);
        });
    });

    describe('object columns', () => {
        test('plain object without operators means equality', () => {
            const predicate = parse({ meta: { color: 'red' } });
            expect(predicate.predicates[0]).toBeInstanceOf(EqPredicate);
            expect(predicate.predicates[0].value).toEqual({ color: 'red' });
        });

        test('eq operator compares the whole object', () => {
            const predicate = parse({ meta: { eq: { eq: 1 } } });
            expect(predicate.predicates[0].value).toEqual({ eq: 1 });
        });

        test('rejects operators mixed with plain keys', () => {
            expect(() =>
                parse({ meta: { eq: { a: 1 }, color: 'red' } })
            ).toThrow(/Unsupported operator "color"/);
        });
    });
});

describe('where and predicates check values the same way', () => {
    const columns = {
        price: { type: 'integer', min: 0, max: 100 },
        status: { type: 'string', enum: ['new', 'done'] },
        active: { type: 'boolean' },
        tags: { type: 'array' },
    };
    const error = (build) => {
        try {
            build();
        } catch (caught) {
            return { code: caught.code, message: caught.message };
        }
        return null;
    };

    test.each([
        ['unknown field', { color: 'red' }, eq('color', 'red')],
        ['wrong type', { price: '5' }, eq('price', '5')],
        ['outside max', { price: { eq: 500 } }, eq('price', 500)],
        ['not in enum', { status: { in: ['old'] } }, inList('status', ['old'])],
        ['ne by type', { price: { ne: 'x' } }, ne('price', 'x')],
        ['range by type', { price: { gt: '5' } }, gt('price', '5')],
        ['range on boolean', { active: { lt: 1 } }, lt('active', 1)],
        ['invalid id', { id: 'abc' }, eq('id', 'abc')],
        [
            'contains on a scalar',
            { status: { contains: 'new' } },
            contains('status', 'new'),
        ],
    ])('%s', (_label, where, predicate) => {
        const fromWhere = error(() => parseWhere(where, columns));
        expect(fromWhere).not.toBeNull();
        expect(error(() => predicate.prepare(columns))).toEqual(fromWhere);
    });
});

describe('contains in where', () => {
    const columns = { category: { type: 'string' }, tags: { type: 'array' } };
    const records = [
        { id: 'a', tags: ['x', 'y'] },
        { id: 'b', tags: ['y'] },
        { id: 'c', tags: [] },
    ];

    test('{ field: { contains } } finds arrays holding the value', async () => {
        const predicate = parseWhere({ tags: { contains: 'x' } }, columns);
        expect((await run(predicate, [], records)).ids).toEqual(['a']);
    });

    test('combines with other operators of the same field', async () => {
        const predicate = parseWhere(
            { tags: { contains: 'y', ne: ['y'] } },
            columns
        );
        expect((await run(predicate, [], records)).ids).toEqual(['a']);
    });

    test('is rejected for columns that are not arrays', () => {
        expect(() =>
            parseWhere({ category: { contains: 'x' } }, columns)
        ).toThrowError(
            expect.objectContaining({
                code: 'INVALID_QUERY',
                message:
                    '"contains" is only supported for array columns, "category" is string.',
            })
        );
    });

    test('is not an id operator', () => {
        expect(() => parseWhere({ id: { contains: 'x' } }, columns)).toThrow(
            /Unsupported operator "contains" for "id"/
        );
    });
});
