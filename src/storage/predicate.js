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
        this.field = field;
        this.value = value;
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
        return isDeepStrictEqual(record[this.field], this.value);
    }
}

export class NePredicate extends Predicate {
    constructor(field, value) {
        super();
        this.field = field;
        this.value = value;
    }

    testRecord(record) {
        return !isDeepStrictEqual(record[this.field], this.value);
    }
}

export class InPredicate extends Predicate {
    constructor(field, values) {
        super();
        this.field = field;
        this.values = Array.isArray(values) ? values : [values];
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
        return this.values.some((v) =>
            isDeepStrictEqual(record[this.field], v)
        );
    }
}

export class RangePredicate extends Predicate {
    constructor(field, range) {
        super();
        this.field = field;
        this.range = range; // { gt, gte, lt, lte }
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
