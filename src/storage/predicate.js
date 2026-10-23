import { isDeepStrictEqual } from 'node:util';
import { matchesRange } from './range.js';

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

const WHERE_OPERATORS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']);
const ID_OPERATORS = new Set(['eq', 'in']);
const RANGE_OPERATORS = ['gt', 'gte', 'lt', 'lte'];
const ORDERABLE_COLUMN_TYPES = new Set(['string', 'number', 'integer']);

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
    const invalidQuery = (message) =>
        new DatabaseErrorClass(message, 400, 'INVALID_QUERY');

    // Rejects empty operator objects and operators outside the allowed set,
    // so that a typo never silently turns into "match everything".
    const assertOperators = (field, value, allowed) => {
        const keys = Object.keys(value);
        if (keys.length === 0) {
            throw invalidQuery(
                `"${field}" filter must contain at least one operator.`
            );
        }
        const unsupported = keys.find((key) => !allowed.has(key));
        if (unsupported !== undefined) {
            throw invalidQuery(
                `Unsupported operator "${unsupported}" for "${field}". ` +
                    `Allowed: ${[...allowed].join(', ')}.`
            );
        }
    };

    if (!isPlainObject(where)) {
        throw invalidQuery('"where" must be a JSON object.');
    }

    const predicates = [];

    for (const [field, value] of Object.entries(where)) {
        if (field === 'id') {
            if (isPlainObject(value)) {
                assertOperators(field, value, ID_OPERATORS);
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
        // Range bounds and "ne" only need the right type: a bound outside
        // min/max or not matching enum/pattern is still a meaningful comparison.
        // An integer column compared with 2.5 is still a meaningful query.
        const typeOnly = {
            type: definition.type === 'integer' ? 'number' : definition.type,
            nullable: definition.nullable,
        };

        // For "object" columns a plain object without operators means equality.
        const isOperatorObject =
            isPlainObject(value) &&
            (definition.type !== 'object' ||
                Object.keys(value).some((key) => WHERE_OPERATORS.has(key)));

        if (isOperatorObject) {
            assertOperators(field, value, WHERE_OPERATORS);

            const usesRange = RANGE_OPERATORS.some(
                (op) => value[op] !== undefined
            );
            if (usesRange && !ORDERABLE_COLUMN_TYPES.has(definition.type)) {
                throw invalidQuery(
                    `Range operators are not supported for "${field}" (${definition.type}).`
                );
            }
            const nullBound = RANGE_OPERATORS.find((op) => value[op] === null);
            if (nullBound !== undefined) {
                throw invalidQuery(
                    `"${field}" ${nullBound} bound cannot be null.`
                );
            }

            const rangeBounds = {};
            for (const op of RANGE_OPERATORS) {
                if (value[op] === undefined) continue;
                validateFieldFn(field, value[op], typeOnly);
                rangeBounds[op] = value[op];
            }
            if (Object.keys(rangeBounds).length > 0) {
                predicates.push(range(field, rangeBounds));
            }
            if (value.eq !== undefined) {
                validateFieldFn(field, value.eq, definition);
                predicates.push(eq(field, value.eq));
            }
            if (value.ne !== undefined) {
                validateFieldFn(field, value.ne, typeOnly);
                predicates.push(ne(field, value.ne));
            }
            if (value.in !== undefined) {
                if (!Array.isArray(value.in)) {
                    throw invalidQuery(
                        `"${field}" IN filter must be an array.`
                    );
                }
                for (const item of value.in) {
                    validateFieldFn(field, item, definition);
                }
                predicates.push(inList(field, value.in));
            }
            continue;
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
