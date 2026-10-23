import { isDeepStrictEqual } from 'node:util';
import { matchesRange } from './range.js';

/**
 * @typedef {import('./query-context.js').QueryContext} QueryContext
 * @typedef {{ gt?: number|string, gte?: number|string, lt?: number|string, lte?: number|string }} RangeBounds
 */

/**
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {Set<string>} Ids present in both sets
 */
function intersect(setA, setB) {
    const result = new Set();
    const [smaller, larger] =
        setA.size <= setB.size ? [setA, setB] : [setB, setA];
    for (const item of smaller) {
        if (larger.has(item)) result.add(item);
    }
    return result;
}

/**
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {Set<string>} Ids present in either set
 */
function union(setA, setB) {
    const result = new Set(setA);
    for (const item of setB) result.add(item);
    return result;
}

const RANGE_KEYS = ['gt', 'gte', 'lt', 'lte'];

/**
 * @param {*} field
 * @returns {string} The field, if it is a non-empty string
 */
function assertField(field) {
    if (typeof field !== 'string' || field === '') {
        throw new TypeError('A predicate field must be a non-empty string.');
    }
    return field;
}

/**
 * @param {*} value
 * @returns {boolean} True for plain objects (not Date, Map, class instances...)
 */
function isJsonObject(value) {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * @param {*} value
 * @returns {string} Short description of a rejected value for error messages
 */
function describeValue(value) {
    if (typeof value === 'number') return String(value);
    if (typeof value === 'object') {
        return value?.constructor?.name ?? 'object without prototype';
    }
    return typeof value;
}

/**
 * Checks a value a record field is compared with. Only values a JSON record
 * can hold are accepted, so filtering with and without an index agrees:
 * JSON.stringify, used by indexes, turns undefined into nothing, NaN and
 * Infinity into null and throws on BigInt. -0 becomes 0, as in stored JSON.
 * @param {*} value
 * @param {string} operator Name used in the error message
 * @returns {*} The value, with -0 normalized
 */
function comparable(value, operator) {
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean'
    ) {
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value === 0 ? 0 : value;
    }
    if (Array.isArray(value) || isJsonObject(value)) return value;
    throw new TypeError(
        `${operator} cannot compare with ${describeValue(value)}: records only hold strings, finite numbers, booleans, null, objects and arrays.`
    );
}

/**
 * Checks range bounds: numbers (±Infinity allowed) or strings.
 * @param {*} range
 * @returns {RangeBounds}
 */
function rangeBounds(range) {
    if (!isJsonObject(range)) {
        throw new TypeError('range() expects an object of bounds.');
    }
    const bounds = {};
    for (const [key, value] of Object.entries(range)) {
        if (!RANGE_KEYS.includes(key)) {
            throw new TypeError(`Unknown range bound "${key}".`);
        }
        if (value === undefined) continue;
        // ±Infinity is a meaningful bound ("no limit"); NaN compares false with everything
        const orderable =
            typeof value === 'string' ||
            (typeof value === 'number' && !Number.isNaN(value));
        if (!orderable) {
            throw new TypeError(
                `Range bound "${key}" must be a number or a string, got ${describeValue(value)}.`
            );
        }
        bounds[key] = value === 0 ? 0 : value;
    }
    return bounds;
}

/**
 * Equality used by predicates, consistent with index keys: primitives compare
 * with === (so -0 equals 0), objects and arrays deeply.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function sameValue(a, b) {
    if (typeof a === 'object' && a !== null) return isDeepStrictEqual(a, b);
    return a === b;
}

/**
 * Base class of query conditions. A predicate can be answered in two ways:
 * through indexes (a set of ids, without reading records) and by testing a
 * record read from disk. `evaluate` combines both.
 *
 * Contract for subclasses:
 * - `applyIndex` is only called when `canUseIndex` is true and must return
 *   a superset of matching ids (an exact set when `isFullyResolvedByIndex`).
 * - `testRecord` must agree with `evaluate` for every record.
 */
export class Predicate {
    /**
     * @param {QueryContext} context
     * @returns {boolean} Whether indexes can narrow the candidates
     */
    canUseIndex() {
        return false;
    }

    /**
     * @param {QueryContext} context
     * @returns {boolean} Whether the index result is exact, so records need not be read
     */
    isFullyResolvedByIndex() {
        return false;
    }

    /**
     * @param {QueryContext} _context
     * @param {Set<string>} candidates Ids still in question
     * @returns {Set<string>} Ids that may match (exact if fully resolved by index)
     */
    applyIndex(_context, candidates) {
        return candidates;
    }

    /**
     * @param {object} record
     * @returns {boolean} Whether the record matches
     */
    testRecord() {
        throw new Error(
            `${this.constructor.name} must implement testRecord().`
        );
    }

    /**
     * Finds matching ids: narrows by index when possible, then tests the
     * remaining candidates on their records.
     * @param {QueryContext} context
     * @param {Set<string>|null} [candidateIds] Ids to choose from; all ids by default
     * @returns {Promise<Set<string>>}
     */
    async evaluate(context, candidateIds = null) {
        let candidates = candidateIds ?? context.getAllIds();

        if (this.canUseIndex(context)) {
            const indexedMatches = this.applyIndex(context, candidates);
            candidates = intersect(candidates, indexedMatches);
            if (this.isFullyResolvedByIndex(context)) {
                return candidates;
            }
        }

        const filtered = new Set();
        for (const id of candidates) {
            const record = await context.getRecord(id);
            if (this.testRecord(record)) {
                filtered.add(id);
            }
        }
        return filtered;
    }
}

/**
 * Matches every record. Created by {@link all}.
 */
export class AllPredicate extends Predicate {
    /** @returns {boolean} Always true: nothing needs to be read */
    canUseIndex() {
        return true;
    }

    /** @returns {boolean} Always true */
    isFullyResolvedByIndex() {
        return true;
    }

    /**
     * @param {QueryContext} _context
     * @param {Set<string>} candidates
     * @returns {Set<string>} All candidates
     */
    applyIndex(_context, candidates) {
        return candidates;
    }

    /** @returns {boolean} Always true */
    testRecord() {
        return true;
    }
}

/**
 * `field` equals `value`. Created by {@link eq}.
 */
export class EqPredicate extends Predicate {
    /**
     * @param {string} field
     * @param {*} value A JSON value: string, finite number, boolean, null, object or array
     */
    constructor(field, value) {
        super();
        this.field = assertField(field);
        this.value = comparable(value, 'eq()');
    }

    /** @param {QueryContext} context */
    canUseIndex(context) {
        return context.isIndexed(this.field);
    }

    /** @param {QueryContext} context */
    isFullyResolvedByIndex(context) {
        return context.isIndexed(this.field);
    }

    /**
     * @param {QueryContext} context
     * @returns {Set<string>} Ids whose field has exactly this value
     */
    applyIndex(context) {
        return context.lookupIndex(this.field, this.value) ?? new Set();
    }

    /** @param {object} record */
    testRecord(record) {
        return sameValue(record[this.field], this.value);
    }
}

/**
 * `field` does not equal `value`; also matches records without the field.
 * Always tests records. Created by {@link ne}.
 */
export class NePredicate extends Predicate {
    /**
     * @param {string} field
     * @param {*} value A JSON value
     */
    constructor(field, value) {
        super();
        this.field = assertField(field);
        this.value = comparable(value, 'ne()');
    }

    /** @param {object} record */
    testRecord(record) {
        return !sameValue(record[this.field], this.value);
    }
}

/**
 * `field` equals any of `values`. Created by {@link inList}.
 */
export class InPredicate extends Predicate {
    /**
     * @param {string} field
     * @param {*|Array<*>} values JSON values; a single value is wrapped into an array
     */
    constructor(field, values) {
        super();
        this.field = assertField(field);
        this.values = (Array.isArray(values) ? values : [values]).map((value) =>
            comparable(value, 'inList()')
        );
    }

    /** @param {QueryContext} context */
    canUseIndex(context) {
        return context.isIndexed(this.field);
    }

    /** @param {QueryContext} context */
    isFullyResolvedByIndex(context) {
        return context.isIndexed(this.field);
    }

    /**
     * @param {QueryContext} context
     * @returns {Set<string>} Ids whose field has one of the values
     */
    applyIndex(context) {
        return context.lookupInList(this.field, this.values) ?? new Set();
    }

    /** @param {object} record */
    testRecord(record) {
        return this.values.some((v) => sameValue(record[this.field], v));
    }
}

/**
 * `field` lies within bounds. Only numbers and strings of the bound's type
 * match: null, missing values and other types never do. Created by
 * {@link gt}, {@link gte}, {@link lt}, {@link lte} and {@link range}.
 */
export class RangePredicate extends Predicate {
    /**
     * @param {string} field
     * @param {RangeBounds} range Any combination of gt, gte, lt and lte
     */
    constructor(field, range) {
        super();
        this.field = assertField(field);
        this.range = rangeBounds(range);
    }

    /** @param {QueryContext} context */
    canUseIndex(context) {
        return context.isIndexed(this.field);
    }

    /** @param {QueryContext} context */
    isFullyResolvedByIndex(context) {
        return context.isIndexed(this.field);
    }

    /**
     * @param {QueryContext} context
     * @returns {Set<string>} Ids whose field lies within the bounds
     */
    applyIndex(context) {
        return context.lookupRange(this.field, this.range) ?? new Set();
    }

    /** @param {object} record */
    testRecord(record) {
        return matchesRange(record[this.field], this.range);
    }
}

/**
 * Matches records for which a function returns a truthy value. Always tests
 * records. Created by {@link custom}.
 */
export class CustomPredicate extends Predicate {
    /**
     * @param {(record: object) => boolean} fn Synchronous test of one record
     */
    constructor(fn) {
        super();
        if (typeof fn !== 'function') {
            throw new TypeError('custom() expects a function.');
        }
        this.fn = fn;
    }

    /** @param {object} record */
    testRecord(record) {
        const result = this.fn(record);
        // a Promise is always truthy, so an async function would match every record
        if (typeof result?.then === 'function') {
            throw new TypeError(
                'custom() predicate must be synchronous and return a boolean, not a Promise.'
            );
        }
        return Boolean(result);
    }
}

/**
 * All conditions hold. Indexed conditions narrow the candidates first, the
 * rest are tested on the remaining records. Created by {@link and}.
 */
export class AndPredicate extends Predicate {
    /**
     * @param {Predicate[]} [predicates] With none, every record matches
     */
    constructor(predicates = []) {
        super();
        this.predicates = predicates;
    }

    /**
     * Adds one more condition.
     * @param {Predicate} predicate
     * @returns {this}
     */
    add(predicate) {
        this.predicates.push(predicate);
        return this;
    }

    /**
     * @param {QueryContext} context
     * @returns {boolean} True if any condition can use an index
     */
    canUseIndex(context) {
        return this.predicates.some((p) => p.canUseIndex(context));
    }

    /**
     * @param {QueryContext} context
     * @returns {boolean} True if every condition is answered by an index
     */
    isFullyResolvedByIndex(context) {
        return this.predicates.every((p) => p.isFullyResolvedByIndex(context));
    }

    /**
     * @param {QueryContext} context
     * @param {Set<string>} candidates
     * @returns {Set<string>} Intersection of all index results
     */
    applyIndex(context, candidates) {
        let result = candidates;
        for (const pred of this.predicates) {
            if (!pred.canUseIndex(context)) continue;
            result = intersect(result, pred.applyIndex(context, result));
            if (result.size === 0) break;
        }
        return result;
    }

    /** @param {object} record */
    testRecord(record) {
        return this.predicates.every((p) => p.testRecord(record));
    }

    /**
     * Like {@link Predicate#evaluate}, but tests records only against the
     * conditions an index could not answer.
     * @param {QueryContext} context
     * @param {Set<string>|null} [candidateIds]
     * @returns {Promise<Set<string>>}
     */
    async evaluate(context, candidateIds = null) {
        let candidates = candidateIds ?? context.getAllIds();
        if (this.predicates.length === 0) return candidates;

        // Phase 1: Apply all index-aware predicates first to narrow candidates in memory
        candidates = this.applyIndex(context, candidates);
        if (candidates.size === 0) return candidates;

        // Phase 2: For predicates that are not fully resolved by indexes, test records
        const remaining = this.predicates.filter(
            (p) => !p.isFullyResolvedByIndex(context)
        );
        if (remaining.length === 0) {
            return candidates;
        }

        const filtered = new Set();
        for (const id of candidates) {
            const record = await context.getRecord(id);
            if (remaining.every((p) => p.testRecord(record))) {
                filtered.add(id);
            }
        }
        return filtered;
    }
}

/**
 * At least one condition holds. Created by {@link or}.
 */
export class OrPredicate extends Predicate {
    /**
     * @param {Predicate[]} [predicates] With none, no record matches
     */
    constructor(predicates = []) {
        super();
        this.predicates = predicates;
    }

    /**
     * A union narrows candidates only if every branch can be narrowed by an index.
     * @param {QueryContext} context
     * @returns {boolean}
     */
    canUseIndex(context) {
        return this.predicates.every((p) => p.canUseIndex(context));
    }

    /**
     * @param {QueryContext} context
     * @returns {boolean} True if every branch is answered by an index
     */
    isFullyResolvedByIndex(context) {
        return this.predicates.every((p) => p.isFullyResolvedByIndex(context));
    }

    /**
     * @param {QueryContext} context
     * @param {Set<string>} candidates
     * @returns {Set<string>} Union of all index results
     */
    applyIndex(context, candidates) {
        let result = new Set();
        for (const pred of this.predicates) {
            result = union(result, pred.applyIndex(context, candidates));
        }
        return result;
    }

    /** @param {object} record */
    testRecord(record) {
        return this.predicates.some((p) => p.testRecord(record));
    }
}

/**
 * `field` equals `value`. Objects and arrays are compared deeply.
 * @param {string} field
 * @param {string|number|boolean|null|object|Array<*>} value
 * @returns {EqPredicate}
 * @example
 * db.list('kids', { predicate: eq('groupId', groupId) });
 * db.list('kids', { predicate: eq('groupId', null) }); // kids without a group
 */
export const eq = (field, value) => new EqPredicate(field, value);

/**
 * `field` does not equal `value` (records without the field match too).
 * @param {string} field
 * @param {string|number|boolean|null|object|Array<*>} value
 * @returns {NePredicate}
 * @example
 * db.list('teachers', { predicate: ne('role', 'manager') });
 */
export const ne = (field, value) => new NePredicate(field, value);

/**
 * `field` is greater than `value`.
 * @param {string} field
 * @param {number|string} value
 * @returns {RangePredicate}
 * @example
 * db.list('kids', { predicate: gt('age', 3) });
 */
export const gt = (field, value) => new RangePredicate(field, { gt: value });

/**
 * `field` is greater than or equal to `value`.
 * @param {string} field
 * @param {number|string} value
 * @returns {RangePredicate}
 * @example
 * db.list('payments', { predicate: gte('paidAt', '2026-09-01') });
 */
export const gte = (field, value) => new RangePredicate(field, { gte: value });

/**
 * `field` is less than `value`.
 * @param {string} field
 * @param {number|string} value
 * @returns {RangePredicate}
 * @example
 * db.list('kids', { predicate: lt('age', 4) });
 */
export const lt = (field, value) => new RangePredicate(field, { lt: value });

/**
 * `field` is less than or equal to `value`.
 * @param {string} field
 * @param {number|string} value
 * @returns {RangePredicate}
 * @example
 * db.list('groups', { predicate: lte('capacity', 20) });
 */
export const lte = (field, value) => new RangePredicate(field, { lte: value });

/**
 * `field` lies within several bounds at once.
 * @param {string} field
 * @param {RangeBounds} bounds
 * @returns {RangePredicate}
 * @example
 * db.list('kids', { predicate: range('age', { gte: 3, lt: 5 }) }); // 3 or 4
 */
export const range = (field, bounds) => new RangePredicate(field, bounds);

/**
 * `field` equals any of `values` (SQL `IN`).
 * @param {string} field
 * @param {Array<string|number|boolean|null|object>} values
 * @returns {InPredicate}
 * @example
 * db.list('teachers', { predicate: inList('role', ['teacher', 'assistant']) });
 */
export const inList = (field, values) => new InPredicate(field, values);

/**
 * All conditions hold. Conditions may be nested freely.
 * @param {...Predicate} predicates
 * @returns {AndPredicate}
 * @example
 * db.list('kids', {
 *     predicate: and(eq('groupId', groupId), or(lt('age', 3), eq('needsSpeechTherapy', true))),
 * });
 */
export const and = (...predicates) => new AndPredicate(predicates);

/**
 * At least one condition holds. `or()` without conditions matches nothing.
 * @param {...Predicate} predicates
 * @returns {OrPredicate}
 * @example
 * db.list('teachers', { predicate: or(eq('role', 'teacher'), eq('role', 'assistant')) });
 */
export const or = (...predicates) => new OrPredicate(predicates);

/**
 * Any synchronous test of a record. It always reads records, so prefer the
 * other predicates for conditions they can express.
 * @param {(record: object) => boolean} fn Must not be async
 * @returns {CustomPredicate}
 * @example
 * db.list('kids', { predicate: custom((kid) => kid.firstName.startsWith('О')) });
 */
export const custom = (fn) => new CustomPredicate(fn);

/**
 * Matches every record.
 * @returns {AllPredicate}
 * @example
 * db.list('kids', { predicate: all() }); // same as no predicate
 */
export const all = () => new AllPredicate();
