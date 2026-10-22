import { isDeepStrictEqual } from 'node:util';

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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
        return true;
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
        const val = record[this.field];
        if (this.range.gt !== undefined && !(val > this.range.gt)) return false;
        if (this.range.gte !== undefined && !(val >= this.range.gte))
            return false;
        if (this.range.lt !== undefined && !(val < this.range.lt)) return false;
        if (this.range.lte !== undefined && !(val <= this.range.lte))
            return false;
        return true;
    }
}

export class CustomPredicate extends Predicate {
    constructor(fn) {
        super();
        this.fn = fn;
    }

    testRecord(record) {
        return Boolean(this.fn(record));
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

    async evaluate(context, candidateIds = null) {
        let candidates = candidateIds ?? context.getAllIds();
        if (this.predicates.length === 0) return candidates;

        // Phase 1: Apply all index-aware predicates first to narrow candidates in memory
        const indexable = this.predicates.filter((p) => p.canUseIndex(context));
        for (const pred of indexable) {
            const matches = pred.applyIndex(context, candidates);
            candidates = intersect(candidates, matches);
            if (candidates.size === 0) return candidates;
        }

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

    async evaluate(context, candidateIds = null) {
        const allCandidates = candidateIds ?? context.getAllIds();
        if (this.predicates.length === 0) return allCandidates;

        // If all sub-predicates are fully resolved by index:
        if (this.predicates.every((p) => p.isFullyResolvedByIndex(context))) {
            let matches = new Set();
            for (const pred of this.predicates) {
                const subMatches = pred.applyIndex(context, allCandidates);
                matches = union(matches, subMatches);
            }
            return intersect(allCandidates, matches);
        }

        // Otherwise evaluate each and union
        let combined = new Set();
        for (const pred of this.predicates) {
            const result = await pred.evaluate(context, allCandidates);
            combined = union(combined, result);
        }
        return combined;
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

/**
 * Adapter that converts a legacy `where` query object into an AndPredicate chain,
 * validating all fields and values.
 */
Predicate.fromWhere = function fromWhere(
    where,
    columns,
    validateFieldFn,
    DatabaseErrorClass,
    validateIdFn
) {
    if (!isPlainObject(where)) {
        throw new DatabaseErrorClass(
            '"where" must be a JSON object.',
            400,
            'INVALID_QUERY'
        );
    }

    const predicates = [];

    for (const [field, value] of Object.entries(where)) {
        if (field === 'id') {
            if (isPlainObject(value)) {
                if (value.eq !== undefined) {
                    if (validateIdFn) validateIdFn(value.eq);
                    predicates.push(eq('id', value.eq));
                }
                if (value.in !== undefined) {
                    if (!Array.isArray(value.in)) {
                        throw new DatabaseErrorClass(
                            '"id" IN filter must be an array.',
                            400,
                            'INVALID_QUERY'
                        );
                    }
                    for (const id of value.in) {
                        if (validateIdFn) validateIdFn(id);
                    }
                    predicates.push(inList('id', value.in));
                }
            } else {
                if (validateIdFn) validateIdFn(value);
                predicates.push(eq('id', value));
            }
            continue;
        }

        if (!Object.hasOwn(columns, field)) {
            throw new DatabaseErrorClass(
                `Unknown filter field "${field}".`,
                400,
                'INVALID_QUERY'
            );
        }

        const definition = columns[field];

        if (isPlainObject(value)) {
            const hasOperators =
                value.eq !== undefined ||
                value.ne !== undefined ||
                value.gt !== undefined ||
                value.gte !== undefined ||
                value.lt !== undefined ||
                value.lte !== undefined ||
                value.in !== undefined;

            if (hasOperators) {
                const rangeBounds = {};
                if (value.gt !== undefined) {
                    validateFieldFn(field, value.gt, definition);
                    rangeBounds.gt = value.gt;
                }
                if (value.gte !== undefined) {
                    validateFieldFn(field, value.gte, definition);
                    rangeBounds.gte = value.gte;
                }
                if (value.lt !== undefined) {
                    validateFieldFn(field, value.lt, definition);
                    rangeBounds.lt = value.lt;
                }
                if (value.lte !== undefined) {
                    validateFieldFn(field, value.lte, definition);
                    rangeBounds.lte = value.lte;
                }
                if (Object.keys(rangeBounds).length > 0) {
                    predicates.push(range(field, rangeBounds));
                }
                if (value.eq !== undefined) {
                    validateFieldFn(field, value.eq, definition);
                    predicates.push(eq(field, value.eq));
                }
                if (value.ne !== undefined) {
                    validateFieldFn(field, value.ne, definition);
                    predicates.push(ne(field, value.ne));
                }
                if (value.in !== undefined) {
                    if (!Array.isArray(value.in)) {
                        throw new DatabaseErrorClass(
                            `"${field}" IN filter must be an array.`,
                            400,
                            'INVALID_QUERY'
                        );
                    }
                    for (const item of value.in) {
                        validateFieldFn(field, item, definition);
                    }
                    predicates.push(inList(field, value.in));
                }
                continue;
            }
        }

        // Direct equality
        validateFieldFn(field, value, definition);
        predicates.push(eq(field, value));
    }

    if (predicates.length === 0) {
        return all();
    }
    return and(...predicates);
};
