import { DatabaseError, DatabaseErrors } from './errors.js';
import { parseWhere } from './where.js';
import { compareRecords, parseSort } from './sort.js';
import { validateId } from './validator.js';

/**
 * @typedef {object} QuerySource
 * Read interface shared by Collection and the transaction view (CollectionView).
 * @property {object} queryColumns Columns filters and sorting may use
 * @property {() => Set<string>} ids Copy of all record ids
 * @property {(id: string) => boolean} has
 * @property {(field: string) => boolean} hasIndex
 * @property {(field: string) => boolean} hasElementIndex Array field indexed by element
 * @property {(field: string, value: *) => Set<string>|null} lookupElementIndex
 * @property {(field: string, value: *) => Set<string>|null} lookupIndex
 * @property {(field: string, values: Array<*>) => Set<string>|null} lookupInIndex
 * @property {(field: string, inRange: (value: *) => boolean) => Set<string>|null} lookupRangeIndex
 * @property {(id: string) => Promise<object>} readRecord
 */

/**
 * State of one query: index lookups over a query source, with the primary key
 * "id" treated as an index, and lazy per-query caching of records read from disk.
 */
export class QueryContext {
    #source;
    #cache = new Map();

    /**
     * @param {QuerySource} source
     */
    constructor(source) {
        this.#source = source;
    }

    /**
     * @returns {Set<string>} Copy of all record ids
     */
    getAllIds() {
        return this.#source.ids();
    }

    /**
     * @param {string} field
     * @returns {boolean} True for indexed fields and the primary key
     */
    isIndexed(field) {
        return field === 'id' || this.#source.hasIndex(field);
    }

    /**
     * @param {string} field
     * @returns {boolean} True for array fields indexed by element
     */
    isElementIndexed(field) {
        return this.#source.hasElementIndex(field);
    }

    /**
     * Records whose array field holds the value.
     * @param {string} field
     * @param {*} value
     * @returns {Set<string>|null} null if the field has no element index
     */
    lookupElement(field, value) {
        return this.#source.lookupElementIndex(field, value);
    }

    /**
     * Exact matches from the index.
     * @param {string} field
     * @param {*} value
     * @returns {Set<string>|null} null if the field is not indexed
     */
    lookupIndex(field, value) {
        if (field === 'id') {
            return this.#source.has(value) ? new Set([value]) : new Set();
        }
        return this.#source.lookupIndex(field, value);
    }

    /**
     * Matches of any of the values (IN operator).
     * @param {string} field
     * @param {Array<*>} values
     * @returns {Set<string>|null}
     */
    lookupInList(field, values) {
        if (!Array.isArray(values)) return new Set();
        if (field === 'id') {
            return new Set(values.filter((id) => this.#source.has(id)));
        }
        return this.#source.lookupInIndex(field, values);
    }

    /**
     * Ids whose value lies within a range.
     * @param {string} field
     * @param {(value: *) => boolean} inRange Decides for each value
     * @returns {Set<string>|null} null if the field is not indexed
     */
    lookupRange(field, inRange) {
        if (field === 'id') {
            const result = new Set();
            for (const id of this.#source.ids()) {
                if (inRange(id)) result.add(id);
            }
            return result;
        }
        return this.#source.lookupRangeIndex(field, inRange);
    }

    /**
     * Reads a record once per query.
     * @param {string} id
     * @returns {Promise<object>}
     */
    async getRecord(id) {
        if (!this.#cache.has(id)) {
            this.#cache.set(id, await this.#source.readRecord(id));
        }
        return this.#cache.get(id);
    }
}

/**
 * Runs a paginated query against a query source (a Collection or a transaction view).
 * @param {QuerySource} source
 * @param {object} [options]
 * @param {object} [options.where] Legacy filter object
 * @param {Predicate} [options.predicate] Predicate chain
 * @param {number} [options.limit=100] Max items (1-500)
 * @param {string|string[]} [options.sort] e.g. "lastName", "-age" or "lastName,-age"; default by id
 * @param {number} [options.offset=0] Pagination offset (>= 0)
 * @returns {Promise<{ items: object[], total: number, limit: number, offset: number }>}
 */
export async function executeList(source, options) {
    const {
        where = {},
        predicate = null,
        sort = null,
        limit = 100,
        offset = 0,
    } = options ?? {};
    if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 500 ||
        !Number.isInteger(offset) ||
        offset < 0
    ) {
        throw new DatabaseError(
            DatabaseErrors.INVALID_QUERY,
            '"limit" must be 1–500 and "offset" must be zero or greater.'
        );
    }

    const keys = parseSort(sort, source.queryColumns);
    // Both are checked against the columns and normalized by Predicate#prepare
    const activePredicate = predicate
        ? predicate.prepare(source.queryColumns)
        : parseWhere(where, source.queryColumns);

    const context = new QueryContext(source);
    const candidateIds = await activePredicate.evaluate(context);
    const ordered = await orderIds(candidateIds, keys, context);
    const pageIds = ordered.slice(offset, offset + limit);
    const items = await Promise.all(pageIds.map((id) => context.getRecord(id)));

    return { items, total: candidateIds.size, limit, offset };
}

/**
 * @returns {DatabaseError} 404 NOT_FOUND
 */
export function notFound() {
    return new DatabaseError(DatabaseErrors.NOT_FOUND, 'Record not found.');
}

/**
 * Reads one record of a query source (a Collection or a transaction view).
 * @param {QuerySource} source
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function executeGet(source, id) {
    validateId(id);
    if (!source.has(id)) throw notFound();
    return source.readRecord(id);
}

/**
 * Orders matching ids. Sorting by id alone needs no record reads; any other
 * field reads the candidates once (cached for the page that follows).
 * @param {Set<string>} ids
 * @param {import('./sort.js').SortKey[]} keys
 * @param {QueryContext} context
 * @returns {Promise<string[]>}
 */
async function orderIds(ids, keys, context) {
    const byId = Array.from(ids).sort();
    if (keys.length === 0) return byId;
    if (keys.length === 1 && keys[0].field === 'id') {
        return keys[0].direction === 1 ? byId : byId.reverse();
    }
    const records = await Promise.all(byId.map((id) => context.getRecord(id)));
    records.sort((a, b) => compareRecords(a, b, keys));
    return records.map((record) => record.id);
}
