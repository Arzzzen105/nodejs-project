import { recordName } from './records.js';

/**
 * Helpers for the descriptions of operations (operations/*.js): the shapes
 * of answers, as JSON Schema.
 */

/**
 * @param {string} collection
 * @returns {object} A reference to the schema of its record
 */
export function record(collection) {
    return { $ref: `#/components/schemas/${recordName(collection)}` };
}

/**
 * A page of a list: `{ items, total, limit, offset }`.
 * @param {object|string} item The schema of an item, or a collection
 * @returns {object}
 */
export function page(item) {
    return object({
        items: { type: 'array', items: schemaOf(item) },
        total: { type: 'integer', description: 'How many match, all pages' },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
    });
}

/**
 * `{ items: [...] }`: several records at once, without pages.
 * @param {object|string} item The schema of an item, or a collection
 */
export function items(item) {
    return object({ items: { type: 'array', items: schemaOf(item) } });
}

/**
 * An object with every property required.
 * @param {Record<string, object>} properties
 * @param {string} [description]
 */
export function object(properties, description) {
    return {
        type: 'object',
        ...(description && { description }),
        required: Object.keys(properties),
        properties,
    };
}

/** Money in hryvnias, rounded to kopecks. */
export const money = { type: 'number', description: 'Hryvnias' };

/** @param {object|string} item */
function schemaOf(item) {
    return typeof item === 'string' ? record(item) : item;
}
