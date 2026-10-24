import { describe, beforeEach, test, expect } from 'vitest';
import { QueryContext } from '../../src/storage/query-context.js';
import { IndexManager } from '../../src/storage/index-manager.js';
import { matchesRange } from '../../src/storage/range.js';

const within = (bounds) => (value) => matchesRange(value, bounds);

const RECORDS = [
    { id: 'id-1', category: 'book', tags: ['new'] },
    { id: 'id-2', category: 'toy', tags: [] },
    { id: 'id-3', category: 'book', tags: ['new', 'sale'] },
];

describe('QueryContext', () => {
    let collection;
    let reads;

    beforeEach(() => {
        const indexes = new IndexManager(['category'], ['tags']);
        RECORDS.forEach((r) => indexes.indexRecord(r));
        const byId = new Map(RECORDS.map((r) => [r.id, r]));
        reads = [];
        collection = {
            name: 'items',
            config: { columns: { category: { type: 'string' } } },
            ids: () => new Set(byId.keys()),
            has: (id) => byId.has(id),
            hasIndex: (field) => indexes.hasIndex(field),
            hasElementIndex: (field) => indexes.hasElementIndex(field),
            lookupElementIndex: (field, value) =>
                indexes.lookupElement(field, value),
            lookupIndex: (field, value) => indexes.lookup(field, value),
            lookupInIndex: (field, values) => indexes.lookupIn(field, values),
            lookupRangeIndex: (field, inRange) =>
                indexes.lookupRange(field, inRange),
            readRecord: async (id) => {
                reads.push(id);
                return byId.get(id);
            },
        };
    });

    test('getAllIds returns a copy', () => {
        const context = new QueryContext(collection);
        const ids = context.getAllIds();
        ids.delete('id-1');
        expect(collection.has('id-1')).toBe(true);
        expect(context.getAllIds().size).toBe(3);
    });

    test('isIndexed treats id as indexed', () => {
        const context = new QueryContext(collection);
        expect(context.isIndexed('id')).toBe(true);
        expect(context.isIndexed('category')).toBe(true);
        expect(context.isIndexed('title')).toBe(false);
    });

    describe('id lookups use the primary key set', () => {
        test('lookupIndex', () => {
            const context = new QueryContext(collection);
            expect(context.lookupIndex('id', 'id-2')).toEqual(
                new Set(['id-2'])
            );
            expect(context.lookupIndex('id', 'missing')).toEqual(new Set());
        });

        test('lookupInList', () => {
            const context = new QueryContext(collection);
            expect(
                context.lookupInList('id', ['id-1', 'id-3', 'missing'])
            ).toEqual(new Set(['id-1', 'id-3']));
        });

        test('lookupRange compares ids as strings', () => {
            const context = new QueryContext(collection);
            expect(context.lookupRange('id', within({ gt: 'id-1' }))).toEqual(
                new Set(['id-2', 'id-3'])
            );
        });
    });

    describe('field lookups delegate to the collection index', () => {
        test('lookupIndex', () => {
            const context = new QueryContext(collection);
            expect(context.lookupIndex('category', 'book')).toEqual(
                new Set(['id-1', 'id-3'])
            );
            expect(context.lookupIndex('title', 'x')).toBeNull();
        });

        test('lookupInList', () => {
            const context = new QueryContext(collection);
            expect(context.lookupInList('category', ['toy'])).toEqual(
                new Set(['id-2'])
            );
        });

        test('lookupInList with a non-array returns an empty set', () => {
            const context = new QueryContext(collection);
            expect(context.lookupInList('category', 'toy')).toEqual(new Set());
        });

        test('element lookups go to the element index', () => {
            const context = new QueryContext(collection);
            expect(context.isElementIndexed('tags')).toBe(true);
            expect(context.isElementIndexed('category')).toBe(false);
            expect(context.lookupElement('tags', 'new')).toEqual(
                new Set(['id-1', 'id-3'])
            );
            expect(context.lookupElement('category', 'book')).toBeNull();
        });

        test('lookupRange', () => {
            const context = new QueryContext(collection);
            expect(
                context.lookupRange('category', within({ lt: 'c' }))
            ).toEqual(new Set(['id-1', 'id-3']));
        });
    });

    describe('getRecord', () => {
        test('reads each record once per context', async () => {
            const context = new QueryContext(collection);
            await context.getRecord('id-1');
            await context.getRecord('id-1');
            await context.getRecord('id-2');
            expect(reads).toEqual(['id-1', 'id-2']);
        });

        test('cache is not shared between contexts', async () => {
            await new QueryContext(collection).getRecord('id-1');
            await new QueryContext(collection).getRecord('id-1');
            expect(reads).toEqual(['id-1', 'id-1']);
        });
    });
});
