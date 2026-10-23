import { matchesRange } from './range.js';

function valueKey(value) {
    return JSON.stringify(value);
}

/**
 * Manages in-memory indexes (field -> valueKey -> Set<id>) for a single collection.
 */
export class IndexManager {
    #indexes = new Map();

    /**
     * @param {string[]} indexedFields List of column names that have indexes
     */
    constructor(indexedFields = []) {
        for (const field of indexedFields) {
            this.#indexes.set(field, new Map());
        }
    }

    /**
     * @param {string} field
     * @returns {boolean}
     */
    hasIndex(field) {
        return this.#indexes.has(field);
    }

    /**
     * Adds record to all defined indexes.
     * @param {object} record
     */
    indexRecord(record) {
        for (const [field, index] of this.#indexes) {
            if (!Object.hasOwn(record, field)) continue;
            const key = valueKey(record[field]);
            if (!index.has(key)) index.set(key, new Set());
            index.get(key).add(record.id);
        }
    }

    /**
     * Removes record from all defined indexes.
     * @param {object} record
     */
    unindexRecord(record) {
        for (const [field, index] of this.#indexes) {
            if (!Object.hasOwn(record, field)) continue;
            const key = valueKey(record[field]);
            const ids = index.get(key);
            ids?.delete(record.id);
            if (ids?.size === 0) index.delete(key);
        }
    }

    /**
     * Look up IDs by exact field value in index.
     * @param {string} field
     * @param {*} value
     * @returns {Set<string>|null}
     */
    lookup(field, value) {
        const index = this.#indexes.get(field);
        if (!index) return null;
        const key = valueKey(value);
        const matches = index.get(key);
        return matches ? new Set(matches) : new Set();
    }

    /**
     * Look up IDs matching any of the given values (IN operator).
     * @param {string} field
     * @param {Array<*>} values
     * @returns {Set<string>|null}
     */
    lookupIn(field, values) {
        const index = this.#indexes.get(field);
        if (!index) return null;
        const result = new Set();
        for (const val of values) {
            const key = valueKey(val);
            const matches = index.get(key);
            if (matches) {
                for (const id of matches) result.add(id);
            }
        }
        return result;
    }

    /**
     * Look up IDs matching a range filter in the index.
     * @param {string} field
     * @param {{ gt?: *, gte?: *, lt?: *, lte?: * }} range
     * @returns {Set<string>|null}
     */
    lookupRange(field, bounds) {
        const index = this.#indexes.get(field);
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
}
