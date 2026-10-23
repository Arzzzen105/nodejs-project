import { DatabaseError } from './errors.js';
import { eq, ne, range, inList, and, all } from './predicate.js';
import { isPlainObject, validateField, validateId } from './validator.js';

const WHERE_OPERATORS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']);
const ID_OPERATORS = new Set(['eq', 'in']);
const RANGE_OPERATORS = ['gt', 'gte', 'lt', 'lte'];
const ORDERABLE_COLUMN_TYPES = new Set(['string', 'number', 'integer']);

/**
 * Converts a `where` query object into a predicate, validating fields and values
 * against the collection columns.
 * @param {object} where e.g. `{ age: { gte: 3 }, groupId: null }`
 * @param {object} columns Column definitions of the collection
 * @returns {import('./predicate.js').Predicate}
 */
export function parseWhere(where, columns) {
    const invalidQuery = (message) =>
        new DatabaseError(message, 400, 'INVALID_QUERY');

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
                    validateId(value.eq);
                    predicates.push(eq('id', value.eq));
                }
                if (value.in !== undefined) {
                    if (!Array.isArray(value.in)) {
                        throw new DatabaseError(
                            '"id" IN filter must be an array.',
                            400,
                            'INVALID_QUERY'
                        );
                    }
                    for (const id of value.in) {
                        validateId(id);
                    }
                    predicates.push(inList('id', value.in));
                }
            } else {
                validateId(value);
                predicates.push(eq('id', value));
            }
            continue;
        }

        if (!Object.hasOwn(columns, field)) {
            throw new DatabaseError(
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
                validateField(field, value[op], typeOnly);
                rangeBounds[op] = value[op];
            }
            if (Object.keys(rangeBounds).length > 0) {
                predicates.push(range(field, rangeBounds));
            }
            if (value.eq !== undefined) {
                validateField(field, value.eq, definition);
                predicates.push(eq(field, value.eq));
            }
            if (value.ne !== undefined) {
                validateField(field, value.ne, typeOnly);
                predicates.push(ne(field, value.ne));
            }
            if (value.in !== undefined) {
                if (!Array.isArray(value.in)) {
                    throw invalidQuery(
                        `"${field}" IN filter must be an array.`
                    );
                }
                for (const item of value.in) {
                    validateField(field, item, definition);
                }
                predicates.push(inList(field, value.in));
            }
            continue;
        }

        // Direct equality
        validateField(field, value, definition);
        predicates.push(eq(field, value));
    }

    if (predicates.length === 0) {
        return all();
    }
    return and(...predicates);
}
