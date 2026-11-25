import fs from 'node:fs';
import path from 'node:path';

/** The schemas of the collections: the records the API answers with. */
const SCHEMA_DIR = path.resolve(import.meta.dirname, '..', '..', 'database');

/** Fields a record has in the API that its collection does not store. */
const DERIVED = {
    groups: {
        attendsSpeechLessons: {
            type: 'boolean',
            description:
                'At least one kid of the group needs speech lessons (FR-021).',
        },
    },
};

/** Columns of type `array` whose items have a shape of their own. */
const ITEMS = {
    invoices: { lines: { $ref: '#/components/schemas/InvoiceLine' } },
    schedules: { unplaced: { $ref: '#/components/schemas/Unplaced' } },
};

/** Schemas of those items, for the components of the document. */
export const ITEM_SCHEMAS = {
    InvoiceLine: {
        type: 'object',
        description:
            'A line of an invoice, fixed when it is issued. Discounts are negative.',
        required: ['type', 'amount'],
        properties: {
            type: {
                type: 'string',
                enum: ['TUITION', 'DISCOUNT', 'ANNUAL_DISCOUNT', 'MEALS'],
            },
            amount: { type: 'number', description: 'Hryvnias' },
            months: {
                type: 'integer',
                description: 'Of TUITION: 1, or 12 paid in advance',
            },
            name: { type: 'string', description: 'Of DISCOUNT: its name' },
            rate: { type: 'number', description: 'Of a discount, 0–1' },
            pricePerDay: { type: 'number', description: 'Of MEALS' },
            days: { type: 'integer', description: 'Of MEALS' },
        },
    },
    Unplaced: {
        type: 'object',
        description: 'Lessons of a group the generator found no place for.',
        required: ['groupId', 'subjectId', 'missing', 'reason'],
        properties: {
            groupId: { type: 'string', format: 'uuid' },
            subjectId: { type: 'string', format: 'uuid' },
            missing: {
                type: 'integer',
                description: 'How many of its lessons a week',
            },
            reason: {
                type: 'string',
                enum: ['NO_TEACHER', 'NO_ROOM', 'NO_FREE_SLOT'],
            },
        },
    },
};

/** Fields the API never shows. */
const HIDDEN = { users: ['passwordHash'] };

/**
 * The name of the schema of a record of a collection: `kids` → `Kid`.
 * @param {string} collection
 * @returns {string}
 */
export function recordName(collection) {
    const special = { schedule_entries: 'ScheduleEntry', settings: 'Settings' };
    if (special[collection]) return special[collection];
    const singular = collection.endsWith('ies')
        ? `${collection.slice(0, -3)}y`
        : collection.replace(/s$/, '');
    return singular[0].toUpperCase() + singular.slice(1);
}

/**
 * JSON Schemas of the records of every collection, from their
 * `database/<collection>/config.json`: the same rules the database checks.
 * @returns {Record<string, object>} By the name of the schema (`Kid`)
 */
export function recordSchemas() {
    const schemas = {};
    for (const collection of fs.readdirSync(SCHEMA_DIR).sort()) {
        const file = path.join(SCHEMA_DIR, collection, 'config.json');
        if (!fs.existsSync(file)) continue;
        const config = JSON.parse(fs.readFileSync(file, 'utf8'));
        schemas[recordName(collection)] = recordSchema(collection, config);
    }
    return schemas;
}

/**
 * @param {string} collection
 * @param {object} config Of the collection
 * @returns {object} JSON Schema of a record as the API returns it
 */
function recordSchema(collection, config) {
    const hidden = HIDDEN[collection] ?? [];
    const properties = {
        id: { type: 'string', format: 'uuid', readOnly: true },
    };
    for (const [name, column] of Object.entries(config.columns)) {
        if (hidden.includes(name)) continue;
        properties[name] = columnSchema(column);
        const shape = ITEMS[collection]?.[name];
        if (shape) properties[name].items = shape;
    }
    if (config.timestamps) {
        for (const name of ['createdAt', 'updatedAt']) {
            properties[name] = {
                type: 'string',
                format: 'date-time',
                readOnly: true,
            };
        }
    }
    Object.assign(properties, DERIVED[collection]);
    return {
        type: 'object',
        // the database fills every column, with its default or null
        required: Object.keys(properties),
        properties,
    };
}

/**
 * @param {object} column Of a config.json
 * @returns {object} JSON Schema
 */
function columnSchema(column) {
    const types = {
        string: { type: 'string' },
        integer: { type: 'integer' },
        number: { type: 'number' },
        boolean: { type: 'boolean' },
        date: { type: 'string', format: 'date' },
        datetime: { type: 'string', format: 'date-time' },
        object: { type: 'object' },
        array: { type: 'array' },
    };
    const schema = { ...types[column.type] };
    if (column.references) {
        schema.format = 'uuid';
        schema.description = `Id of a record of ${column.references.collection}.`;
    }
    if (column.type === 'array') {
        schema.items = column.items?.references
            ? {
                  type: 'string',
                  format: 'uuid',
                  description: `Id of a record of ${column.items.references.collection}.`,
              }
            : {};
    }
    if (column.enum) schema.enum = column.enum;
    if (column.min !== undefined) schema.minimum = column.min;
    if (column.max !== undefined) schema.maximum = column.max;
    if (column.minLength !== undefined) schema.minLength = column.minLength;
    if (column.maxLength !== undefined) schema.maxLength = column.maxLength;
    if (column.pattern) schema.pattern = column.pattern;
    if (column.nullable) {
        schema.type = [schema.type, 'null'];
        if (schema.enum) schema.enum = [...schema.enum, null];
    }
    return schema;
}
