import { DatabaseError, DatabaseErrors } from './errors.js';
import {
    eq,
    ne,
    range,
    inList,
    and,
    all,
    assertQueryField,
} from './predicate.js';
import { isPlainObject } from './validator.js';

const WHERE_OPERATORS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']);
const ID_OPERATORS = new Set(['eq', 'in']);
const RANGE_OPERATORS = ['gt', 'gte', 'lt', 'lte'];

/**
 * Converts a `where` query object into a predicate. Only the shape of the
 * object is checked here (operators, arrays, null bounds); fields and values
 * are checked against the columns by `Predicate#prepare`, the same way as for
 * predicates written in code.
 * @param {object} where e.g. `{ age: { gte: 3 }, groupId: null }`
 * @param {object} columns Column definitions of the collection
 * @returns {import('./predicate.js').Predicate}
 */
export function parseWhere(where, columns) {
    const invalidQuery = (message) =>
        new DatabaseError(DatabaseErrors.INVALID_QUERY, message);

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
                    predicates.push(eq('id', value.eq));
                }
                if (value.in !== undefined) {
                    if (!Array.isArray(value.in)) {
                        throw new DatabaseError(
                            DatabaseErrors.INVALID_QUERY,
                            '"id" IN filter must be an array.'
                        );
                    }
                    predicates.push(inList('id', value.in));
                }
            } else {
                predicates.push(eq('id', value));
            }
            continue;
        }

        assertQueryField(field, columns);

        // For "object" columns a plain object without operators means equality.
        const isOperatorObject =
            isPlainObject(value) &&
            (columns[field].type !== 'object' ||
                Object.keys(value).some((key) => WHERE_OPERATORS.has(key)));

        if (isOperatorObject) {
            assertOperators(field, value, WHERE_OPERATORS);

            // range() only takes numbers and strings; anything else is a bad request here
            for (const op of RANGE_OPERATORS) {
                const bound = value[op];
                if (bound === null) {
                    throw invalidQuery(
                        `"${field}" ${op} bound cannot be null.`
                    );
                }
                if (
                    bound !== undefined &&
                    typeof bound !== 'string' &&
                    typeof bound !== 'number'
                ) {
                    throw invalidQuery(
                        `"${field}" ${op} bound must be a number or a string.`
                    );
                }
            }

            const rangeBounds = {};
            for (const op of RANGE_OPERATORS) {
                if (value[op] === undefined) continue;
                rangeBounds[op] = value[op];
            }
            if (Object.keys(rangeBounds).length > 0) {
                predicates.push(range(field, rangeBounds));
            }
            if (value.eq !== undefined) {
                predicates.push(eq(field, value.eq));
            }
            if (value.ne !== undefined) {
                predicates.push(ne(field, value.ne));
            }
            if (value.in !== undefined) {
                if (!Array.isArray(value.in)) {
                    throw invalidQuery(
                        `"${field}" IN filter must be an array.`
                    );
                }
                predicates.push(inList(field, value.in));
            }
            continue;
        }

        // Direct equality
        predicates.push(eq(field, value));
    }

    const predicate = predicates.length === 0 ? all() : and(...predicates);
    return predicate.prepare(columns);
}
