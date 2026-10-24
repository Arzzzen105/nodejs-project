import { describe, beforeEach, test, expect } from 'vitest';
import { IndexManager } from '../../src/storage/index-manager.js';
import { matchesRange } from '../../src/storage/range.js';

const within = (bounds) => (value) => matchesRange(value, bounds);

describe('IndexManager', () => {
    let indexes;

    beforeEach(() => {
        indexes = new IndexManager(['category', 'price']);
        indexes.indexRecord({ id: 'a', category: 'book', price: 10 });
        indexes.indexRecord({ id: 'b', category: 'book', price: 25 });
        indexes.indexRecord({ id: 'c', category: 'toy', price: 5 });
    });

    test('hasIndex reports configured fields only', () => {
        expect(indexes.hasIndex('category')).toBe(true);
        expect(indexes.hasIndex('price')).toBe(true);
        expect(indexes.hasIndex('title')).toBe(false);
        expect(new IndexManager().hasIndex('category')).toBe(false);
    });

    describe('lookup', () => {
        test('returns ids with the exact value', () => {
            expect(indexes.lookup('category', 'book')).toEqual(
                new Set(['a', 'b'])
            );
        });

        test('returns an empty set for unknown values', () => {
            expect(indexes.lookup('category', 'car')).toEqual(new Set());
        });

        test('returns null for unindexed fields', () => {
            expect(indexes.lookup('title', 'x')).toBeNull();
        });

        test('distinguishes values of different types', () => {
            indexes.indexRecord({ id: 'd', category: '10', price: '10' });
            expect(indexes.lookup('price', 10)).toEqual(new Set(['a']));
            expect(indexes.lookup('price', '10')).toEqual(new Set(['d']));
        });

        test('returns a copy that does not affect the index', () => {
            indexes.lookup('category', 'book').add('zzz');
            expect(indexes.lookup('category', 'book')).toEqual(
                new Set(['a', 'b'])
            );
        });

        test('indexes null values', () => {
            indexes.indexRecord({ id: 'n', category: null });
            expect(indexes.lookup('category', null)).toEqual(new Set(['n']));
        });

        test('skips records without the field', () => {
            indexes.indexRecord({ id: 'm', category: 'toy' });
            expect(indexes.lookup('price', undefined)).toEqual(new Set());
            expect(indexes.lookup('category', 'toy')).toEqual(
                new Set(['c', 'm'])
            );
        });
    });

    describe('lookupIn', () => {
        test('unites matches of all values', () => {
            expect(indexes.lookupIn('category', ['toy', 'book'])).toEqual(
                new Set(['a', 'b', 'c'])
            );
        });

        test('ignores missing values', () => {
            expect(indexes.lookupIn('category', ['toy', 'car'])).toEqual(
                new Set(['c'])
            );
        });

        test('returns an empty set for empty list', () => {
            expect(indexes.lookupIn('category', [])).toEqual(new Set());
        });

        test('returns null for unindexed fields', () => {
            expect(indexes.lookupIn('title', ['x'])).toBeNull();
        });
    });

    describe('lookupRange', () => {
        test('filters by bounds', () => {
            expect(indexes.lookupRange('price', within({ gte: 10 }))).toEqual(
                new Set(['a', 'b'])
            );
            expect(
                indexes.lookupRange('price', within({ gt: 5, lt: 25 }))
            ).toEqual(new Set(['a']));
        });

        test('works for strings', () => {
            expect(
                indexes.lookupRange('category', within({ gt: 'c' }))
            ).toEqual(new Set(['c']));
        });

        test('skips null and values of another type', () => {
            indexes.indexRecord({ id: 'n', price: null });
            indexes.indexRecord({ id: 's', price: '7' });
            expect(indexes.lookupRange('price', within({ lt: 100 }))).toEqual(
                new Set(['a', 'b', 'c'])
            );
        });

        test('returns null for unindexed fields', () => {
            expect(indexes.lookupRange('title', within({ gt: 0 }))).toBeNull();
        });

        test('asks the range about each distinct value once, ids not involved', () => {
            const asked = [];
            const result = indexes.lookupRange('category', (value) => {
                asked.push(value);
                return value === 'book';
            });
            expect(asked.sort()).toEqual(['book', 'toy']);
            expect(result).toEqual(new Set(['a', 'b']));
        });
    });

    describe('unindexRecord', () => {
        test('removes the record from every index', () => {
            indexes.unindexRecord({ id: 'a', category: 'book', price: 10 });
            expect(indexes.lookup('category', 'book')).toEqual(new Set(['b']));
            expect(indexes.lookup('price', 10)).toEqual(new Set());
        });

        test('drops empty value buckets', () => {
            indexes.unindexRecord({ id: 'c', category: 'toy', price: 5 });
            expect(indexes.lookupRange('price', within({}))).toEqual(
                new Set(['a', 'b'])
            );
        });

        test('is a no-op for unknown records and values', () => {
            expect(() =>
                indexes.unindexRecord({ id: 'zzz', category: 'car' })
            ).not.toThrow();
            expect(indexes.lookup('category', 'book')).toEqual(
                new Set(['a', 'b'])
            );
        });

        test('reindexing after unindex reflects the new value', () => {
            const before = { id: 'a', category: 'book', price: 10 };
            const after = { ...before, category: 'toy' };
            indexes.unindexRecord(before);
            indexes.indexRecord(after);
            expect(indexes.lookup('category', 'book')).toEqual(new Set(['b']));
            expect(indexes.lookup('category', 'toy')).toEqual(
                new Set(['a', 'c'])
            );
        });
    });
});

describe('IndexManager element indexes', () => {
    let indexes;

    beforeEach(() => {
        indexes = new IndexManager(['category'], ['tagIds']);
        indexes.indexRecord({ id: 'a', category: 'x', tagIds: ['t1', 't2'] });
        indexes.indexRecord({ id: 'b', category: 'y', tagIds: ['t2'] });
        indexes.indexRecord({ id: 'c', category: 'y', tagIds: [] });
    });

    test('element indexes are not exposed as value indexes', () => {
        expect(indexes.hasIndex('tagIds')).toBe(false);
        expect(indexes.hasElementIndex('tagIds')).toBe(true);
        expect(indexes.hasElementIndex('category')).toBe(false);
        expect(indexes.lookup('tagIds', ['t2'])).toBeNull();
    });

    test('lookupElement finds records containing the value', () => {
        expect(indexes.lookupElement('tagIds', 't2')).toEqual(
            new Set(['a', 'b'])
        );
        expect(indexes.lookupElement('tagIds', 't1')).toEqual(new Set(['a']));
        expect(indexes.lookupElement('tagIds', 't9')).toEqual(new Set());
    });

    test('lookupElement returns null for fields without element index', () => {
        expect(indexes.lookupElement('category', 'x')).toBeNull();
    });

    test('duplicate elements are indexed once', () => {
        indexes.indexRecord({ id: 'd', tagIds: ['t3', 't3'] });
        indexes.unindexRecord({ id: 'd', tagIds: ['t3', 't3'] });
        expect(indexes.lookupElement('tagIds', 't3')).toEqual(new Set());
    });

    test('non-array values are ignored', () => {
        indexes.indexRecord({ id: 'e', tagIds: 't1' });
        indexes.indexRecord({ id: 'f', tagIds: null });
        expect(indexes.lookupElement('tagIds', 't1')).toEqual(new Set(['a']));
    });

    test('unindexRecord removes the record from every element', () => {
        indexes.unindexRecord({ id: 'a', category: 'x', tagIds: ['t1', 't2'] });
        expect(indexes.lookupElement('tagIds', 't1')).toEqual(new Set());
        expect(indexes.lookupElement('tagIds', 't2')).toEqual(new Set(['b']));
        expect(indexes.lookup('category', 'x')).toEqual(new Set());
    });

    test('entries lists values with their ids for both index kinds', () => {
        const byValue = (entries) =>
            Object.fromEntries(
                entries.map((e) => [e.value, [...e.ids].sort()])
            );
        expect(byValue(indexes.entries('tagIds'))).toEqual({
            t1: ['a'],
            t2: ['a', 'b'],
        });
        expect(byValue(indexes.entries('category'))).toEqual({
            x: ['a'],
            y: ['b', 'c'],
        });
        expect(indexes.entries('missing')).toBeNull();
    });

    test('entries keeps original value types', () => {
        const typed = new IndexManager(['ref']);
        typed.indexRecord({ id: 'a', ref: null });
        typed.indexRecord({ id: 'b', ref: 5 });
        expect(typed.entries('ref').map((e) => e.value)).toEqual([null, 5]);
    });
});
