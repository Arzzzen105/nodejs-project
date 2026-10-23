import { DatabaseError } from './errors.js';
import { Predicate } from './predicate.js';
import { matchesRange } from './range.js';
import { validateField, validateId } from './validator.js';

/**
 * QueryContext acts as an abstraction wrapper over a collection during query execution.
 * It provides index lookups in memory and on-demand (lazy) cached loading of records from disk.
 */
export class QueryContext {
    #collection;
    #readRecordFn;
    #cache = new Map();

    /**
     * @param {object} collection Collection instance
     * @param {Function} [readRecordFn] Optional custom function (id) => Promise<object>
     */
    constructor(collection, readRecordFn = null) {
        this.#collection = collection;
        this.#readRecordFn =
            readRecordFn ?? ((id) => collection.readRecord(id));
    }

    get collectionName() {
        return this.#collection.name;
    }

    get columns() {
        return this.#collection.config.columns;
    }

    get totalRecordsCount() {
        return this.#collection.records.size;
    }

    /**
     * Returns a copy of all record IDs currently known in memory.
     * @returns {Set<string>}
     */
    getAllIds() {
        return new Set(this.#collection.records);
    }

    /**
     * Checks if a field is indexed or is the primary key "id".
     * @param {string} field
     * @returns {boolean}
     */
    isIndexed(field) {
        if (field === 'id') return true;
        if (typeof this.#collection.hasIndex === 'function') {
            return this.#collection.hasIndex(field);
        }
        return this.#collection.indexes?.has?.(field) ?? false;
    }

    /**
     * Look up exact matches in the in-memory index.
     * @param {string} field
     * @param {*} value
     * @returns {Set<string>|null} Set of matching IDs, or null if unindexed
     */
    lookupIndex(field, value) {
        if (field === 'id') {
            return this.#collection.records.has(value)
                ? new Set([value])
                : new Set();
        }
        if (typeof this.#collection.lookupIndex === 'function') {
            return this.#collection.lookupIndex(field, value);
        }
        const index = this.#collection.indexes?.get?.(field);
        if (!index) return null;
        const key = JSON.stringify(value);
        const matches = index.get(key);
        return matches ? new Set(matches) : new Set();
    }

    /**
     * Look up multiple values in the in-memory index (IN operator).
     * @param {string} field
     * @param {Array<*>} values
     * @returns {Set<string>|null}
     */
    lookupInList(field, values) {
        if (!Array.isArray(values)) return new Set();

        if (field === 'id') {
            const result = new Set();
            for (const v of values) {
                if (this.#collection.records.has(v)) result.add(v);
            }
            return result;
        }

        if (typeof this.#collection.lookupInIndex === 'function') {
            return this.#collection.lookupInIndex(field, values);
        }

        const index = this.#collection.indexes?.get?.(field);
        if (!index) return null;

        const result = new Set();
        for (const val of values) {
            const key = JSON.stringify(val);
            const matches = index.get(key);
            if (matches) {
                for (const id of matches) result.add(id);
            }
        }
        return result;
    }

    /**
     * Range lookup using in-memory index or lexical IDs.
     * @param {string} field
     * @param {{ gt?: *, gte?: *, lt?: *, lte?: * }} range
     * @returns {Set<string>|null}
     */
    lookupRange(field, bounds) {
        if (field === 'id') {
            const result = new Set();
            for (const id of this.#collection.records) {
                if (matchesRange(id, bounds)) result.add(id);
            }
            return result;
        }

        if (typeof this.#collection.lookupRangeIndex === 'function') {
            return this.#collection.lookupRangeIndex(field, bounds);
        }

        const index = this.#collection.indexes?.get?.(field);
        if (!index) return null;

        const result = new Set();
        for (const [key, idSet] of index.entries()) {
            let val;
            try {
                val = JSON.parse(key);
            } catch {
                continue;
            }
            if (!matchesRange(val, bounds)) continue;

            for (const id of idSet) {
                result.add(id);
            }
        }
        return result;
    }

    /**
     * Lazy read of record from disk with per-query in-memory caching.
     * @param {string} id
     * @returns {Promise<object>}
     */
    async getRecord(id) {
        if (this.#cache.has(id)) {
            return this.#cache.get(id);
        }
        const record = await this.#readRecordFn(id);
        this.#cache.set(id, record);
        return record;
    }
}

/**
 * Runs a paginated query against a query source: a Collection, or a transaction
 * view exposing the same interface (name, config, records, hasIndex, lookup*, readRecord).
 * @param {object} source
 * @param {object} [options]
 * @param {object} [options.where] Legacy filter object
 * @param {Predicate} [options.predicate] Predicate chain
 * @param {number} [options.limit=100] Max items (1-500)
 * @param {number} [options.offset=0] Pagination offset (>= 0)
 * @returns {Promise<{ items: object[], total: number, limit: number, offset: number }>}
 */
export async function executeList(
    source,
    { where = {}, predicate = null, limit = 100, offset = 0 } = {}
) {
    if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 500 ||
        !Number.isInteger(offset) ||
        offset < 0
    ) {
        throw new DatabaseError(
            '"limit" must be 1–500 and "offset" must be zero or greater.',
            400,
            'INVALID_QUERY'
        );
    }

    const activePredicate =
        predicate ??
        Predicate.fromWhere(
            where,
            source.config.columns,
            validateField,
            DatabaseError,
            (id) => validateId(id)
        );

    const context = new QueryContext(source);
    const candidateIds = await activePredicate.evaluate(context);
    const pageIds = Array.from(candidateIds)
        .sort()
        .slice(offset, offset + limit);
    const items = await Promise.all(pageIds.map((id) => context.getRecord(id)));

    return { items, total: candidateIds.size, limit, offset };
}
