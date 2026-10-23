import { isDeepStrictEqual } from 'node:util';
import { matchesRange } from './range.js';

function intersect(setA, setB) {
    const result = new Set();
    const [smaller, larger] =
        setA.size <= setB.size ? [setA, setB] : [setB, setA];
    for (const item of smaller) {
        if (larger.has(item)) result.add(item);
    }
    return result;
}

function union(setA, setB) {
    const result = new Set(setA);
    for (const item of setB) result.add(item);
    return result;
}

const RANGE_KEYS = ['gt', 'gte', 'lt', 'lte'];

function assertField(field) {
    if (typeof field !== 'string' || field === '') {
        throw new TypeError('A predicate field must be a non-empty string.');
    }
    return field;
}

function isJsonObject(value) {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

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
 * @param {*} range
 * @returns {{ gt?: number|string, gte?: number|string, lt?: number|string, lte?: number|string }}
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
 */
function sameValue(a, b) {
    if (typeof a === 'object' && a !== null) return isDeepStrictEqual(a, b);
    return a === b;
}

/**
 * Base abstract Predicate class representing a query condition.
 *
 * Contract for subclasses:
 * - `applyIndex` is only called when `canUseIndex` is true and must return
 *   a superset of matching ids (an exact set when `isFullyResolvedByIndex`).
 * - `testRecord` must agree with `evaluate` for every record.
 */
export class Predicate {
    canUseIndex() {
        return false;
    }

    isFullyResolvedByIndex() {
        return false;
    }

    applyIndex(_context, candidates) {
        return candidates;
    }

    testRecord() {
        throw new Error(
            `${this.constructor.name} must implement testRecord().`
        );
    }

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

export class AllPredicate extends Predicate {
    canUseIndex() {
        return true;
    }
    isFullyResolvedByIndex() {
        return true;
    }
    applyIndex(_context, candidates) {
        return candidates;
    }
    testRecord() {
        return true;
    }
}

export class EqPredicate extends Predicate {
    constructor(field, value) {
        super();
        this.field = assertField(field);
        this.value = comparable(value, 'eq()');
    }

    canUseIndex(context) {
        return context.isIndexed(this.field);
    }

    isFullyResolvedByIndex(context) {
        return context.isIndexed(this.field);
    }

    applyIndex(context) {
        return context.lookupIndex(this.field, this.value) ?? new Set();
    }

    testRecord(record) {
        return sameValue(record[this.field], this.value);
    }
}

export class NePredicate extends Predicate {
    constructor(field, value) {
        super();
        this.field = assertField(field);
        this.value = comparable(value, 'ne()');
    }

    testRecord(record) {
        return !sameValue(record[this.field], this.value);
    }
}

export class InPredicate extends Predicate {
    constructor(field, values) {
        super();
        this.field = assertField(field);
        this.values = (Array.isArray(values) ? values : [values]).map((value) =>
            comparable(value, 'inList()')
        );
    }

    canUseIndex(context) {
        return context.isIndexed(this.field);
    }

    isFullyResolvedByIndex(context) {
        return context.isIndexed(this.field);
    }

    applyIndex(context) {
        return context.lookupInList(this.field, this.values) ?? new Set();
    }

    testRecord(record) {
        return this.values.some((v) => sameValue(record[this.field], v));
    }
}

export class RangePredicate extends Predicate {
    constructor(field, range) {
        super();
        this.field = assertField(field);
        this.range = rangeBounds(range);
    }

    canUseIndex(context) {
        return context.isIndexed(this.field);
    }

    isFullyResolvedByIndex(context) {
        return context.isIndexed(this.field);
    }

    applyIndex(context) {
        return context.lookupRange(this.field, this.range) ?? new Set();
    }

    testRecord(record) {
        return matchesRange(record[this.field], this.range);
    }
}

export class CustomPredicate extends Predicate {
    constructor(fn) {
        super();
        if (typeof fn !== 'function') {
            throw new TypeError('custom() expects a function.');
        }
        this.fn = fn;
    }

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

export class AndPredicate extends Predicate {
    constructor(predicates = []) {
        super();
        this.predicates = predicates;
    }

    add(predicate) {
        this.predicates.push(predicate);
        return this;
    }

    canUseIndex(context) {
        return this.predicates.some((p) => p.canUseIndex(context));
    }

    isFullyResolvedByIndex(context) {
        return this.predicates.every((p) => p.isFullyResolvedByIndex(context));
    }

    applyIndex(context, candidates) {
        let result = candidates;
        for (const pred of this.predicates) {
            if (!pred.canUseIndex(context)) continue;
            result = intersect(result, pred.applyIndex(context, result));
            if (result.size === 0) break;
        }
        return result;
    }

    testRecord(record) {
        return this.predicates.every((p) => p.testRecord(record));
    }

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

export class OrPredicate extends Predicate {
    constructor(predicates = []) {
        super();
        this.predicates = predicates;
    }

    // A union narrows candidates only if every branch can be narrowed by an index.
    canUseIndex(context) {
        return this.predicates.every((p) => p.canUseIndex(context));
    }

    isFullyResolvedByIndex(context) {
        return this.predicates.every((p) => p.isFullyResolvedByIndex(context));
    }

    applyIndex(context, candidates) {
        let result = new Set();
        for (const pred of this.predicates) {
            result = union(result, pred.applyIndex(context, candidates));
        }
        return result;
    }

    testRecord(record) {
        return this.predicates.some((p) => p.testRecord(record));
    }
}

// Fluent factory functions
export const eq = (field, value) => new EqPredicate(field, value);
export const ne = (field, value) => new NePredicate(field, value);
export const gt = (field, value) => new RangePredicate(field, { gt: value });
export const gte = (field, value) => new RangePredicate(field, { gte: value });
export const lt = (field, value) => new RangePredicate(field, { lt: value });
export const lte = (field, value) => new RangePredicate(field, { lte: value });
export const range = (field, bounds) => new RangePredicate(field, bounds);
export const inList = (field, values) => new InPredicate(field, values);
export const and = (...predicates) => new AndPredicate(predicates);
export const or = (...predicates) => new OrPredicate(predicates);
export const custom = (fn) => new CustomPredicate(fn);
export const all = () => new AllPredicate();
