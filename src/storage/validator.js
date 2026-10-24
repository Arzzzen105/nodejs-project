import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import { DatabaseError, DatabaseErrors } from './errors.js';
import { isDate, isDatetime, normalizeDatetime } from './dates.js';

export const COLLECTION_NAME = /^[a-z][a-z0-9_-]*$/;

// Compiled `pattern` regexes by column definition. Kept outside the config, so
// schema() returns exactly what config.json contains.
const compiledPatterns = new WeakMap();

/**
 * Returns the compiled regex of a column definition, compiling it once.
 * @param {object} definition
 * @returns {RegExp}
 */
function compiledPattern(definition) {
    let regex = compiledPatterns.get(definition);
    if (!regex) {
        regex = new RegExp(definition.pattern);
        compiledPatterns.set(definition, regex);
    }
    return regex;
}

/**
 * Checks whether the value is a plain, non-null, non-array object.
 * @param {*} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Checks if the string is a valid UUIDv7.
 * @param {*} id
 * @returns {boolean}
 */
export function isValidId(id) {
    return typeof id === 'string' && uuidValidate(id) && uuidVersion(id) === 7;
}

/**
 * Validates that an ID is a valid UUIDv7; throws DatabaseError if invalid.
 * @param {*} id
 */
export function validateId(id) {
    if (!isValidId(id)) {
        throw new DatabaseError(
            DatabaseErrors.INVALID_ID,
            '"id" must be a UUID.'
        );
    }
}

/**
 * Validates collection configuration and precompiles regex patterns.
 * @param {string} name
 * @param {object} config
 */
export function validateConfig(name, config) {
    if (!COLLECTION_NAME.test(name)) {
        throw new DatabaseError(
            DatabaseErrors.INVALID_CONFIG,
            `Invalid collection name: ${name}`
        );
    }
    if (
        !isPlainObject(config) ||
        config.table !== name ||
        config.primaryKey !== 'id'
    ) {
        throw new DatabaseError(
            DatabaseErrors.INVALID_CONFIG,
            `Invalid config for collection "${name}".`
        );
    }
    const unknownKey = Object.keys(config).find(
        (key) => !CONFIG_KEYS.includes(key)
    );
    if (unknownKey !== undefined) {
        throw new DatabaseError(
            DatabaseErrors.INVALID_CONFIG,
            `Unknown option "${unknownKey}" in config of "${name}".`
        );
    }
    if (!isPlainObject(config.columns) || !Array.isArray(config.indexes)) {
        throw new DatabaseError(
            DatabaseErrors.INVALID_CONFIG,
            `Config for "${name}" must define columns and indexes.`
        );
    }
    for (const [column, definition] of Object.entries(config.columns)) {
        if (
            !/^[A-Za-z][A-Za-z0-9_]*$/.test(column) ||
            !isPlainObject(definition)
        ) {
            throw new DatabaseError(
                DatabaseErrors.INVALID_CONFIG,
                `Invalid column definition in "${name}".`
            );
        }
        if (
            ![
                'string',
                'number',
                'integer',
                'boolean',
                'object',
                'array',
                'date',
                'datetime',
            ].includes(definition.type)
        ) {
            throw new DatabaseError(
                DatabaseErrors.INVALID_CONFIG,
                `Invalid type for "${name}.${column}".`
            );
        }
        validateColumnOptions(name, column, definition);
        if (definition.pattern !== undefined) {
            if (typeof definition.pattern !== 'string') {
                throw new DatabaseError(
                    DatabaseErrors.INVALID_CONFIG,
                    `Invalid pattern for "${name}.${column}".`
                );
            }
            try {
                compiledPattern(definition);
            } catch (err) {
                throw new DatabaseError(
                    DatabaseErrors.INVALID_CONFIG,
                    `Invalid pattern regex for "${name}.${column}": ${err.message}`
                );
            }
        }
        validateReferenceColumn(name, column, definition);
        validateDefault(name, column, definition);
    }
    if (
        config.timestamps !== undefined &&
        typeof config.timestamps !== 'boolean'
    ) {
        throw new DatabaseError(
            DatabaseErrors.INVALID_CONFIG,
            `"timestamps" of "${name}" must be a boolean.`
        );
    }
    if (config.timestamps) {
        const declared = Object.keys(TIMESTAMP_COLUMNS).find((column) =>
            Object.hasOwn(config.columns, column)
        );
        if (declared !== undefined) {
            throw new DatabaseError(
                DatabaseErrors.INVALID_CONFIG,
                `"${name}.${declared}" is managed by the database when "timestamps" is on.`
            );
        }
    }
    if (Object.hasOwn(config.columns, 'id')) {
        throw new DatabaseError(
            DatabaseErrors.INVALID_CONFIG,
            'The primary key "id" is managed by the file database.'
        );
    }
    for (const index of config.indexes) {
        const managed =
            config.timestamps === true &&
            Object.hasOwn(TIMESTAMP_COLUMNS, index);
        if (managed) continue;
        if (
            typeof index !== 'string' ||
            !Object.hasOwn(config.columns, index) ||
            config.columns[index]?.type === 'object'
        ) {
            throw new DatabaseError(
                DatabaseErrors.INVALID_CONFIG,
                `Invalid index in collection "${name}".`
            );
        }
    }
}

const CONFIG_KEYS = ['table', 'primaryKey', 'columns', 'indexes', 'timestamps'];

/**
 * Columns the database fills in itself when a config has `"timestamps": true`.
 * They behave like datetime columns for queries and cannot be set by clients.
 */
export const TIMESTAMP_COLUMNS = Object.freeze({
    createdAt: Object.freeze({ type: 'datetime' }),
    updatedAt: Object.freeze({ type: 'datetime' }),
});
const COLUMN_OPTIONS = [
    'type',
    'required',
    'nullable',
    'default',
    'min',
    'max',
    'minLength',
    'maxLength',
    'enum',
    'pattern',
    'references',
    'items',
    'unique',
];
// Types whose values have an order, so they accept min/max.
const ORDERED_TYPES = ['number', 'integer', 'date', 'datetime'];
// Arrays and objects have no single obvious notion of equality for uniqueness.
const UNIQUE_TYPES = [
    'string',
    'number',
    'integer',
    'boolean',
    'date',
    'datetime',
];

/**
 * Rejects unknown, mistyped or meaningless column options, so a typo such as
 * `requred` fails at start instead of being silently ignored.
 * @param {string} name
 * @param {string} column
 * @param {object} definition
 */
function validateColumnOptions(name, column, definition) {
    const invalid = (reason) =>
        new DatabaseError(
            DatabaseErrors.INVALID_CONFIG,
            `Invalid column "${name}.${column}": ${reason}.`
        );

    const unknown = Object.keys(definition).find(
        (key) => !COLUMN_OPTIONS.includes(key)
    );
    if (unknown !== undefined) throw invalid(`unknown option "${unknown}"`);

    for (const flag of ['required', 'nullable', 'unique']) {
        if (
            definition[flag] !== undefined &&
            typeof definition[flag] !== 'boolean'
        ) {
            throw invalid(`"${flag}" must be a boolean`);
        }
    }
    if (definition.unique && !UNIQUE_TYPES.includes(definition.type)) {
        throw invalid(
            `"unique" is not supported for ${definition.type} columns`
        );
    }

    const ordered = ORDERED_TYPES.includes(definition.type);
    for (const bound of ['min', 'max']) {
        if (definition[bound] === undefined) continue;
        if (!ordered) {
            throw invalid(
                `"${bound}" requires a numeric, date or datetime column`
            );
        }
        if (!TYPE_CHECKERS[definition.type](definition[bound])) {
            throw invalid(
                NUMERIC_TYPES.includes(definition.type)
                    ? `"${bound}" must be a finite number`
                    : `"${bound}" must be a valid ${definition.type}`
            );
        }
    }
    if (
        definition.min !== undefined &&
        definition.max !== undefined &&
        compareOrdered(definition.min, definition.max, definition) > 0
    ) {
        throw invalid('"min" must not be greater than "max"');
    }

    for (const bound of ['minLength', 'maxLength']) {
        if (definition[bound] === undefined) continue;
        if (definition.type !== 'string') {
            throw invalid(`"${bound}" requires a string column`);
        }
        if (!Number.isSafeInteger(definition[bound]) || definition[bound] < 0) {
            throw invalid(`"${bound}" must be a non-negative integer`);
        }
    }
    if (definition.minLength > definition.maxLength) {
        throw invalid('"minLength" must not be greater than "maxLength"');
    }

    if (definition.pattern !== undefined && definition.type !== 'string') {
        throw invalid('"pattern" requires a string column');
    }

    if (definition.enum !== undefined) {
        // equal moments may be written differently, so a list of them is not supported
        if (definition.type === 'datetime') {
            throw invalid('"enum" is not supported for datetime columns');
        }
        if (!Array.isArray(definition.enum) || definition.enum.length === 0) {
            throw invalid('"enum" must be a non-empty array');
        }
        const checker = TYPE_CHECKERS[definition.type];
        if (!definition.enum.every((value) => checker(value))) {
            throw invalid(`every "enum" value must be ${definition.type}`);
        }
    }
}

/**
 * A default that breaks the schema would make every create fail, so it is
 * rejected at start.
 * @param {string} name
 * @param {string} column
 * @param {object} definition
 */
function validateDefault(name, column, definition) {
    if (!Object.hasOwn(definition, 'default')) return;
    try {
        validateField(column, definition.default, definition);
    } catch (error) {
        throw new DatabaseError(
            DatabaseErrors.INVALID_CONFIG,
            `Invalid default of "${name}.${column}": ${error.message}`
        );
    }
}

const REFERENCE_OPTIONS = ['collection', 'onDelete'];
const SCALAR_ON_DELETE = ['restrict', 'setNull'];
const ARRAY_ON_DELETE = ['restrict', 'remove'];

/**
 * Validates `references` (string columns) and `items.references` (array columns).
 * Whether the referenced collection exists is checked later, once all configs are known.
 * @param {string} name
 * @param {string} column
 * @param {object} definition
 */
function validateReferenceColumn(name, column, definition) {
    const invalid = (reason) =>
        new DatabaseError(
            DatabaseErrors.INVALID_CONFIG,
            `Invalid reference "${name}.${column}": ${reason}.`
        );

    if (definition.references !== undefined) {
        if (definition.type !== 'string') {
            throw invalid(
                '"references" requires a string column, use "items" for arrays'
            );
        }
        validateReference(definition.references, SCALAR_ON_DELETE, invalid);
        if (
            definition.references.onDelete === 'setNull' &&
            !definition.nullable
        ) {
            throw invalid('"setNull" requires a nullable column');
        }
        if (definition.default !== undefined && definition.default !== null) {
            throw invalid('default value must be null');
        }
    }

    if (definition.items !== undefined) {
        if (definition.type !== 'array') {
            throw invalid('"items" is only allowed for array columns');
        }
        if (
            !isPlainObject(definition.items) ||
            definition.items.references === undefined
        ) {
            throw invalid('"items" must define "references"');
        }
        validateReference(
            definition.items.references,
            ARRAY_ON_DELETE,
            invalid
        );
        if (
            definition.default !== undefined &&
            !(
                Array.isArray(definition.default) &&
                definition.default.length === 0
            )
        ) {
            throw invalid('default value must be an empty array');
        }
    }
}

/**
 * Checks one `references` object: known options, collection name, onDelete rule.
 * @param {*} reference
 * @param {string[]} allowedOnDelete
 * @param {(reason: string) => DatabaseError} invalid Builds the INVALID_CONFIG error
 */
function validateReference(reference, allowedOnDelete, invalid) {
    if (!isPlainObject(reference)) {
        throw invalid('"references" must be an object');
    }
    const unknown = Object.keys(reference).find(
        (key) => !REFERENCE_OPTIONS.includes(key)
    );
    if (unknown !== undefined) {
        throw invalid(`unknown option "${unknown}"`);
    }
    if (
        typeof reference.collection !== 'string' ||
        !COLLECTION_NAME.test(reference.collection)
    ) {
        throw invalid('"collection" must be a valid collection name');
    }
    if (
        reference.onDelete !== undefined &&
        !allowedOnDelete.includes(reference.onDelete)
    ) {
        throw invalid(
            `"onDelete" must be one of: ${allowedOnDelete.join(', ')}`
        );
    }
}

const NUMERIC_TYPES = ['number', 'integer'];

/**
 * Normalizes a value of a column before it is stored or compared: datetime
 * values become canonical UTC strings; everything else stays as it is.
 * @param {*} value A value that already passed validateField
 * @param {object} definition Column definition
 * @returns {*}
 * @example
 * normalizeValue('2026-10-23T12:41+03:00', { type: 'datetime' }); // '2026-10-23T09:41:00.000Z'
 */
export function normalizeValue(value, definition) {
    if (definition.type === 'datetime' && typeof value === 'string') {
        return normalizeDatetime(value) ?? value;
    }
    return value;
}

/**
 * Compares two values of an ordered column (numbers, dates, datetimes).
 * @param {*} a
 * @param {*} b
 * @param {object} definition Column definition
 * @returns {number} Negative, zero or positive
 */
function compareOrdered(a, b, definition) {
    if (typeof a === 'number') return a - b;
    const left = normalizeValue(a, definition);
    const right = normalizeValue(b, definition);
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

// Shown after "must be date"/"must be datetime", where the format is not obvious.
const TYPE_HINTS = {
    date: ' (YYYY-MM-DD, e.g. 2022-03-14)',
    datetime: ' (ISO 8601 with an offset, e.g. 2026-10-23T12:00:00+03:00)',
};

export const TYPE_CHECKERS = {
    string: (value) => typeof value === 'string',
    number: (value) => typeof value === 'number' && Number.isFinite(value),
    integer: (value) => Number.isSafeInteger(value),
    boolean: (value) => typeof value === 'boolean',
    object: (value) => isPlainObject(value),
    array: (value) => Array.isArray(value),
    date: isDate,
    datetime: isDatetime,
};

/**
 * Validates a single field against its schema column definition.
 * @param {string} field Field name
 * @param {*} value Value to validate
 * @param {object} definition Column schema definition
 */
export function validateField(field, value, definition) {
    if (value === null && definition.nullable) return;
    const checker = TYPE_CHECKERS[definition.type];
    if (!checker || !checker(value)) {
        throw new DatabaseError(
            DatabaseErrors.VALIDATION_ERROR,
            `"${field}" must be ${definition.type}${TYPE_HINTS[definition.type] ?? ''}.`
        );
    }
    if (
        definition.min !== undefined &&
        compareOrdered(value, definition.min, definition) < 0
    ) {
        throw new DatabaseError(
            DatabaseErrors.VALIDATION_ERROR,
            `"${field}" must be at least ${definition.min}.`
        );
    }
    if (
        definition.max !== undefined &&
        compareOrdered(value, definition.max, definition) > 0
    ) {
        throw new DatabaseError(
            DatabaseErrors.VALIDATION_ERROR,
            `"${field}" must be at most ${definition.max}.`
        );
    }
    if (
        typeof value === 'string' &&
        definition.minLength !== undefined &&
        value.length < definition.minLength
    ) {
        throw new DatabaseError(
            DatabaseErrors.VALIDATION_ERROR,
            `"${field}" is too short.`
        );
    }
    if (
        typeof value === 'string' &&
        definition.maxLength !== undefined &&
        value.length > definition.maxLength
    ) {
        throw new DatabaseError(
            DatabaseErrors.VALIDATION_ERROR,
            `"${field}" is too long.`
        );
    }
    if (
        definition.enum &&
        !definition.enum.some((choice) => Object.is(choice, value))
    ) {
        throw new DatabaseError(
            DatabaseErrors.VALIDATION_ERROR,
            `"${field}" must be one of the configured values.`
        );
    }
    if (definition.pattern && typeof value === 'string') {
        if (!compiledPattern(definition).test(value)) {
            throw new DatabaseError(
                DatabaseErrors.VALIDATION_ERROR,
                `"${field}" has an invalid format.`
            );
        }
    }
}

/**
 * Normalizes input object according to collection column definitions:
 * rejects unknown fields, applies default values, checks required fields, and validates types.
 * @param {object} columns
 * @param {object} input
 * @param {boolean} creating
 * @returns {object}
 */
export function normalizeRecord(columns, input, creating) {
    const output = {};
    for (const field of Object.keys(input)) {
        if (!Object.hasOwn(columns, field)) {
            throw new DatabaseError(
                DatabaseErrors.VALIDATION_ERROR,
                `Unknown field "${field}".`
            );
        }
    }
    for (const [field, definition] of Object.entries(columns)) {
        if (Object.hasOwn(input, field)) output[field] = input[field];
        else if (creating && Object.hasOwn(definition, 'default'))
            output[field] = structuredClone(definition.default);
        else if (definition.required)
            throw new DatabaseError(
                DatabaseErrors.VALIDATION_ERROR,
                `"${field}" is required.`
            );

        if (Object.hasOwn(output, field)) {
            validateField(field, output[field], definition);
            output[field] = normalizeValue(output[field], definition);
        }
    }
    return output;
}
