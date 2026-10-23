import { describe, beforeEach, test, expect } from 'vitest';
import { IndexManager } from '../../src/storage/index-manager.js';

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
            expect(indexes.lookupRange('price', { gte: 10 })).toEqual(
                new Set(['a', 'b'])
            );
            expect(indexes.lookupRange('price', { gt: 5, lt: 25 })).toEqual(
                new Set(['a'])
            );
        });

        test('works for strings', () => {
            expect(indexes.lookupRange('category', { gt: 'c' })).toEqual(
                new Set(['c'])
            );
        });

        test('skips null and values of another type', () => {
            indexes.indexRecord({ id: 'n', price: null });
            indexes.indexRecord({ id: 's', price: '7' });
            expect(indexes.lookupRange('price', { lt: 100 })).toEqual(
                new Set(['a', 'b', 'c'])
            );
        });

        test('returns null for unindexed fields', () => {
            expect(indexes.lookupRange('title', { gt: 0 })).toBeNull();
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
            expect(indexes.lookupRange('price', {})).toEqual(
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
