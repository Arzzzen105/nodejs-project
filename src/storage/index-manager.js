import { matchesRange } from './range.js';

function valueKey(value) {
    return JSON.stringify(value);
}

/**
 * Manages in-memory indexes (field -> valueKey -> Set<id>) for a single collection.
 *
 * Two kinds of indexes are kept:
 * - value indexes map the whole field value to ids and serve query predicates;
 * - element indexes map every element of an array field to ids. They are used
 *   for reverse reference lookups only and are invisible to `hasIndex`, because
 *   predicates compare arrays as a whole.
 */
export class IndexManager {
    #indexes = new Map();
    #elementIndexes = new Map();

    /**
     * @param {string[]} indexedFields List of column names that have value indexes
     * @param {string[]} [elementFields] List of array columns indexed by element
     */
    constructor(indexedFields = [], elementFields = []) {
        for (const field of indexedFields) {
            this.#indexes.set(field, new Map());
        }
        for (const field of elementFields) {
            this.#elementIndexes.set(field, new Map());
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
     * @param {string} field
     * @returns {boolean}
     */
    hasElementIndex(field) {
        return this.#elementIndexes.has(field);
    }

    /**
     * Adds record to all defined indexes.
     * @param {object} record
     */
    indexRecord(record) {
        for (const [index, key] of this.#entriesOf(record)) {
            if (!index.has(key)) index.set(key, new Set());
            index.get(key).add(record.id);
        }
    }

    /**
     * Removes record from all defined indexes.
     * @param {object} record
     */
    unindexRecord(record) {
        for (const [index, key] of this.#entriesOf(record)) {
            const ids = index.get(key);
            ids?.delete(record.id);
            if (ids?.size === 0) index.delete(key);
        }
    }

    /**
     * Look up IDs of records whose array field contains the value.
     * @param {string} field
     * @param {*} value
     * @returns {Set<string>|null} null if the field has no element index
     */
    lookupElement(field, value) {
        const index = this.#elementIndexes.get(field);
        if (!index) return null;
        const matches = index.get(valueKey(value));
        return matches ? new Set(matches) : new Set();
    }

    /**
     * Lists every indexed value of a field (value or element index) with its ids.
     * @param {string} field
     * @returns {Array<{ value: *, ids: Set<string> }>|null}
     */
    entries(field) {
        const index =
            this.#indexes.get(field) ?? this.#elementIndexes.get(field);
        if (!index) return null;
        return [...index].map(([key, ids]) => ({
            value: JSON.parse(key),
            ids: new Set(ids),
        }));
    }

    /**
     * Yields [index, valueKey] pairs the record occupies in all indexes.
     * @param {object} record
     */
    *#entriesOf(record) {
        for (const [field, index] of this.#indexes) {
            if (!Object.hasOwn(record, field)) continue;
            yield [index, valueKey(record[field])];
        }
        for (const [field, index] of this.#elementIndexes) {
            if (!Array.isArray(record[field])) continue;
            const keys = new Set(record[field].map(valueKey));
            for (const key of keys) yield [index, key];
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
