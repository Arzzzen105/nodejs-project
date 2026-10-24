import { IndexManager } from '../../src/storage/index-manager.js';
import { QueryContext } from '../../src/storage/query-context.js';

export const RECORDS = [
    { id: 'a', category: 'book', price: 10, inStock: true },
    { id: 'b', category: 'book', price: 25, inStock: false },
    { id: 'c', category: 'toy', price: 5, inStock: true },
    { id: 'd', category: 'toy', price: 40, inStock: false },
    { id: 'e', category: 'food', price: 25, inStock: true },
];

/**
 * Builds a QueryContext over an in-memory collection backed by a real IndexManager.
 * `reads` collects ids of records loaded through the context (i.e. not resolved by index).
 * @param {string[]} [indexedFields] Fields with value indexes
 * @param {object[]} [records]
 * @param {string[]} [elementFields] Array fields indexed by element
 */
export function createContext(
    indexedFields = [],
    records = RECORDS,
    elementFields = []
) {
    const indexes = new IndexManager(indexedFields, elementFields);
    const byId = new Map();
    for (const record of records) {
        byId.set(record.id, record);
        indexes.indexRecord(record);
    }

    const reads = [];
    const collection = {
        name: 'products',
        config: { columns: {} },
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

    return { context: new QueryContext(collection), reads };
}

export async function run(
    predicate,
    indexedFields = [],
    records = RECORDS,
    elementFields = []
) {
    const { context, reads } = createContext(
        indexedFields,
        records,
        elementFields
    );
    const ids = [...(await predicate.evaluate(context))].sort();
    return { ids, reads };
}
