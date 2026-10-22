import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import { DatabaseError } from './errors.js';

export const COLLECTION_NAME = /^[a-z][a-z0-9_-]*$/;

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
        if (definition.pattern !== undefined) {
            if (typeof definition.pattern !== 'string') {
                throw new DatabaseError(
                    `Invalid pattern for "${name}.${column}".`,
                    500,
                    'INVALID_CONFIG'
                );
            }
            try {
                definition.compiledPattern = new RegExp(definition.pattern);
            } catch (err) {
                throw new DatabaseError(
                    `Invalid pattern regex for "${name}.${column}": ${err.message}`,
                    500,
                    'INVALID_CONFIG'
                );
            }
        }
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
        const regex =
            definition.compiledPattern ?? new RegExp(definition.pattern);
        if (!regex.test(value)) {
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
