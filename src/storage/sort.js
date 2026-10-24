import { compareCodePoints, compareText } from './collation.js';
import { DatabaseError, DatabaseErrors } from './errors.js';

const SORTABLE_TYPES = [
    'string',
    'number',
    'integer',
    'boolean',
    'date',
    'datetime',
];
// Compared as plain strings: their fixed ISO format already sorts by time.
const PLAIN_STRING_TYPES = ['date', 'datetime'];

/**
 * @typedef {object} SortKey
 * @property {string} field Column name or "id"
 * @property {1|-1} direction 1 ascending, -1 descending
 * @property {boolean} plain Compare strings by code point instead of the Ukrainian collation
 */

/**
 * Parses a sort specification: "lastName", "-age" (descending), "lastName,-age",
 * or an array of such strings. Empty means the default order by id.
 * @param {string|string[]|undefined|null} sort
 * @param {object} columns Column definitions of the collection
 * @returns {SortKey[]}
 */
export function parseSort(sort, columns) {
    if (sort === undefined || sort === null) return [];
    const invalid = (message) =>
        new DatabaseError(DatabaseErrors.INVALID_QUERY, message);

    const parts = Array.isArray(sort) ? sort : [sort];
    if (!parts.every((part) => typeof part === 'string')) {
        throw invalid('"sort" must be a string or an array of strings.');
    }
    const tokens = parts
        .flatMap((part) => part.split(','))
        .map((t) => t.trim());

    const keys = [];
    for (const token of tokens) {
        const descending = token.startsWith('-');
        const field = descending ? token.slice(1) : token;
        if (field === '') throw invalid('"sort" contains an empty field.');
        if (field !== 'id') {
            if (!Object.hasOwn(columns, field)) {
                throw invalid(`Unknown sort field "${field}".`);
            }
            if (!SORTABLE_TYPES.includes(columns[field].type)) {
                throw invalid(
                    `Cannot sort by "${field}" (${columns[field].type}).`
                );
            }
        }
        if (keys.some((key) => key.field === field)) {
            throw invalid(`Sort field "${field}" is repeated.`);
        }
        keys.push({
            field,
            direction: descending ? -1 : 1,
            plain:
                field === 'id' ||
                PLAIN_STRING_TYPES.includes(columns[field].type),
        });
    }
    return keys;
}

/**
 * Compares two records by the sort keys. Null and missing values always come
 * last, whatever the direction; ties are broken by id (creation order), so
 * pages never overlap.
 * @param {object} a
 * @param {object} b
 * @param {SortKey[]} keys
 * @returns {number}
 */
export function compareRecords(a, b, keys) {
    for (const { field, direction, plain } of keys) {
        // ids, dates and datetimes compare as plain strings: their order is time order
        const result = compareValues(a[field], b[field], direction, plain);
        if (result !== 0) return result;
    }
    return compareCodePoints(a.id, b.id);
}

/**
 * Compares two field values; null and missing values go last in both directions.
 * @param {*} a
 * @param {*} b
 * @param {1|-1} direction
 * @param {boolean} plain Compare strings by code point
 * @returns {number}
 */
function compareValues(a, b, direction, plain) {
    const aMissing = a === undefined || a === null;
    const bMissing = b === undefined || b === null;
    if (aMissing || bMissing) return Number(aMissing) - Number(bMissing);
    return direction * compareTyped(a, b, plain);
}

// Values of another type than the column (e.g. records written before a schema
// change) are ordered by type, so sorting stays deterministic.
const TYPE_RANK = { number: 0, string: 1, boolean: 2 };

/**
 * Compares two non-null values: by type first, then by value.
 * @param {*} a
 * @param {*} b
 * @param {boolean} plain Compare strings by code point
 * @returns {number}
 */
function compareTyped(a, b, plain) {
    const rankA = TYPE_RANK[typeof a] ?? 3;
    const rankB = TYPE_RANK[typeof b] ?? 3;
    if (rankA !== rankB) return rankA - rankB;
    if (typeof a === 'number') return a - b;
    if (typeof a === 'string') {
        return plain ? compareCodePoints(a, b) : compareText(a, b);
    }
    if (typeof a === 'boolean') return Number(a) - Number(b);
    return 0;
}
