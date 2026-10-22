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
    lookupRange(field, { gt, gte, lt, lte }) {
        if (field === 'id') {
            const result = new Set();
            for (const id of this.#collection.records) {
                if (gt !== undefined && !(id > gt)) continue;
                if (gte !== undefined && !(id >= gte)) continue;
                if (lt !== undefined && !(id < lt)) continue;
                if (lte !== undefined && !(id <= lte)) continue;
                result.add(id);
            }
            return result;
        }

        if (typeof this.#collection.lookupRangeIndex === 'function') {
            return this.#collection.lookupRangeIndex(field, {
                gt,
                gte,
                lt,
                lte,
            });
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
            if (gt !== undefined && !(val > gt)) continue;
            if (gte !== undefined && !(val >= gte)) continue;
            if (lt !== undefined && !(val < lt)) continue;
            if (lte !== undefined && !(val <= lte)) continue;

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
