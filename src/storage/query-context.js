import { DatabaseError } from './errors.js';
import { parseWhere } from './where.js';
import { matchesRange } from './range.js';
import { validateId } from './validator.js';

/**
 * @typedef {object} QuerySource
 * Read interface shared by Collection and the transaction view (CollectionView).
 * @property {{ columns: object }} config
 * @property {() => Set<string>} ids Copy of all record ids
 * @property {(id: string) => boolean} has
 * @property {(field: string) => boolean} hasIndex
 * @property {(field: string, value: *) => Set<string>|null} lookupIndex
 * @property {(field: string, values: Array<*>) => Set<string>|null} lookupInIndex
 * @property {(field: string, bounds: object) => Set<string>|null} lookupRangeIndex
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
     * Matches of range bounds; ids compare as strings.
     * @param {string} field
     * @param {{ gt?: *, gte?: *, lt?: *, lte?: * }} bounds
     * @returns {Set<string>|null}
     */
    lookupRange(field, bounds) {
        if (field === 'id') {
            const result = new Set();
            for (const id of this.#source.ids()) {
                if (matchesRange(id, bounds)) result.add(id);
            }
            return result;
        }
        return this.#source.lookupRangeIndex(field, bounds);
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
        predicate ?? parseWhere(where, source.config.columns);

    const context = new QueryContext(source);
    const candidateIds = await activePredicate.evaluate(context);
    const pageIds = Array.from(candidateIds)
        .sort()
        .slice(offset, offset + limit);
    const items = await Promise.all(pageIds.map((id) => context.getRecord(id)));

    return { items, total: candidateIds.size, limit, offset };
}

/**
 * @returns {DatabaseError} 404 NOT_FOUND
 */
export function notFound() {
    return new DatabaseError('Record not found.', 404, 'NOT_FOUND');
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
