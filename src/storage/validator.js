import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import { DatabaseError } from './errors.js';

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
        throw new DatabaseError('"id" must be a UUID.', 400, 'INVALID_ID');
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
            `Invalid collection name: ${name}`,
            500,
            'INVALID_CONFIG'
        );
    }
    if (
        !isPlainObject(config) ||
        config.table !== name ||
        config.primaryKey !== 'id'
    ) {
        throw new DatabaseError(
            `Invalid config for collection "${name}".`,
            500,
            'INVALID_CONFIG'
        );
    }
    const unknownKey = Object.keys(config).find(
        (key) => !CONFIG_KEYS.includes(key)
    );
    if (unknownKey !== undefined) {
        throw new DatabaseError(
            `Unknown option "${unknownKey}" in config of "${name}".`,
            500,
            'INVALID_CONFIG'
        );
    }
    if (!isPlainObject(config.columns) || !Array.isArray(config.indexes)) {
        throw new DatabaseError(
            `Config for "${name}" must define columns and indexes.`,
            500,
            'INVALID_CONFIG'
        );
    }
    for (const [column, definition] of Object.entries(config.columns)) {
        if (
            !/^[A-Za-z][A-Za-z0-9_]*$/.test(column) ||
            !isPlainObject(definition)
        ) {
            throw new DatabaseError(
                `Invalid column definition in "${name}".`,
                500,
                'INVALID_CONFIG'
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
            ].includes(definition.type)
        ) {
            throw new DatabaseError(
                `Invalid type for "${name}.${column}".`,
                500,
                'INVALID_CONFIG'
            );
        }
        validateColumnOptions(name, column, definition);
        if (definition.pattern !== undefined) {
            if (typeof definition.pattern !== 'string') {
                throw new DatabaseError(
                    `Invalid pattern for "${name}.${column}".`,
                    500,
                    'INVALID_CONFIG'
                );
            }
            try {
                compiledPattern(definition);
            } catch (err) {
                throw new DatabaseError(
                    `Invalid pattern regex for "${name}.${column}": ${err.message}`,
                    500,
                    'INVALID_CONFIG'
                );
            }
        }
        validateReferenceColumn(name, column, definition);
        validateDefault(name, column, definition);
    }
    if (Object.hasOwn(config.columns, 'id')) {
        throw new DatabaseError(
            'The primary key "id" is managed by the file database.',
            500,
            'INVALID_CONFIG'
        );
    }
    for (const index of config.indexes) {
        if (
            typeof index !== 'string' ||
            !Object.hasOwn(config.columns, index) ||
            ['object', 'array'].includes(config.columns[index]?.type)
        ) {
            throw new DatabaseError(
                `Invalid index in collection "${name}".`,
                500,
                'INVALID_CONFIG'
            );
        }
    }
}

const CONFIG_KEYS = ['table', 'primaryKey', 'columns', 'indexes'];
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
];
const NUMERIC_TYPES = ['number', 'integer'];

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
            `Invalid column "${name}.${column}": ${reason}.`,
            500,
            'INVALID_CONFIG'
        );

    const unknown = Object.keys(definition).find(
        (key) => !COLUMN_OPTIONS.includes(key)
    );
    if (unknown !== undefined) throw invalid(`unknown option "${unknown}"`);

    for (const flag of ['required', 'nullable']) {
        if (
            definition[flag] !== undefined &&
            typeof definition[flag] !== 'boolean'
        ) {
            throw invalid(`"${flag}" must be a boolean`);
        }
    }

    const numeric = NUMERIC_TYPES.includes(definition.type);
    for (const bound of ['min', 'max']) {
        if (definition[bound] === undefined) continue;
        if (!numeric) throw invalid(`"${bound}" requires a numeric column`);
        if (!Number.isFinite(definition[bound])) {
            throw invalid(`"${bound}" must be a finite number`);
        }
    }
    if (definition.min > definition.max) {
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
            `Invalid default of "${name}.${column}": ${error.message}`,
            500,
            'INVALID_CONFIG'
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
            `Invalid reference "${name}.${column}": ${reason}.`,
            500,
            'INVALID_CONFIG'
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

export const TYPE_CHECKERS = {
    string: (value) => typeof value === 'string',
    number: (value) => typeof value === 'number' && Number.isFinite(value),
    integer: (value) => Number.isSafeInteger(value),
    boolean: (value) => typeof value === 'boolean',
    object: (value) => isPlainObject(value),
    array: (value) => Array.isArray(value),
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
            `"${field}" must be ${definition.type}.`,
            422,
            'VALIDATION_ERROR'
        );
    }
    if (
        typeof value === 'number' &&
        definition.min !== undefined &&
        value < definition.min
    ) {
        throw new DatabaseError(
            `"${field}" must be at least ${definition.min}.`,
            422,
            'VALIDATION_ERROR'
        );
    }
    if (
        typeof value === 'number' &&
        definition.max !== undefined &&
        value > definition.max
    ) {
        throw new DatabaseError(
            `"${field}" must be at most ${definition.max}.`,
            422,
            'VALIDATION_ERROR'
        );
    }
    if (
        typeof value === 'string' &&
        definition.minLength !== undefined &&
        value.length < definition.minLength
    ) {
        throw new DatabaseError(
            `"${field}" is too short.`,
            422,
            'VALIDATION_ERROR'
        );
    }
    if (
        typeof value === 'string' &&
        definition.maxLength !== undefined &&
        value.length > definition.maxLength
    ) {
        throw new DatabaseError(
            `"${field}" is too long.`,
            422,
            'VALIDATION_ERROR'
        );
    }
    if (
        definition.enum &&
        !definition.enum.some((choice) => Object.is(choice, value))
    ) {
        throw new DatabaseError(
            `"${field}" must be one of the configured values.`,
            422,
            'VALIDATION_ERROR'
        );
    }
    if (definition.pattern && typeof value === 'string') {
        if (!compiledPattern(definition).test(value)) {
            throw new DatabaseError(
                `"${field}" has an invalid format.`,
                422,
                'VALIDATION_ERROR'
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
                `Unknown field "${field}".`,
                422,
                'VALIDATION_ERROR'
            );
        }
    }
    for (const [field, definition] of Object.entries(columns)) {
        if (Object.hasOwn(input, field)) output[field] = input[field];
        else if (creating && Object.hasOwn(definition, 'default'))
            output[field] = structuredClone(definition.default);
        else if (definition.required)
            throw new DatabaseError(
                `"${field}" is required.`,
                422,
                'VALIDATION_ERROR'
            );

        if (Object.hasOwn(output, field)) {
            validateField(field, output[field], definition);
        }
    }
    return output;
}
