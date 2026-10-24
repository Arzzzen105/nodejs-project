import { StatusCodes } from 'http-status-codes';

/**
 * @typedef {object} DatabaseErrorType
 * @property {string} code Machine-readable code, e.g. "NOT_FOUND"
 * @property {number} status Suggested HTTP status
 * @property {string} description When the error happens
 */

/**
 * @param {string} code
 * @param {number} status
 * @param {string} description
 * @returns {Readonly<DatabaseErrorType>}
 */
function define(code, status, description) {
    return Object.freeze({ code, status, description });
}

/**
 * Catalog of every error the storage engine raises. Each code is bound to its
 * HTTP status here and only here, so the same code can never come with
 * different statuses. Engine-internal: higher layers look at `error.status`.
 */
export const DatabaseErrors = Object.freeze({
    // 400: the request itself is malformed
    INVALID_BODY: define(
        'INVALID_BODY',
        StatusCodes.BAD_REQUEST,
        'The record body is not a JSON object.'
    ),
    INVALID_ID: define(
        'INVALID_ID',
        StatusCodes.BAD_REQUEST,
        'The id is not a UUIDv7.'
    ),
    INVALID_QUERY: define(
        'INVALID_QUERY',
        StatusCodes.BAD_REQUEST,
        'A filter, sort or pagination option is invalid.'
    ),
    INVALID_COLLECTION: define(
        'INVALID_COLLECTION',
        StatusCodes.BAD_REQUEST,
        'The collection name is malformed.'
    ),

    // 404: something does not exist
    NOT_FOUND: define(
        'NOT_FOUND',
        StatusCodes.NOT_FOUND,
        'No record with this id.'
    ),
    COLLECTION_NOT_FOUND: define(
        'COLLECTION_NOT_FOUND',
        StatusCodes.NOT_FOUND,
        'No collection with this name.'
    ),

    // 409: the change conflicts with stored data
    REFERENCE_RESTRICT: define(
        'REFERENCE_RESTRICT',
        StatusCodes.CONFLICT,
        'The record cannot be deleted: other records reference it (onDelete: restrict).'
    ),
    UNIQUE_VIOLATION: define(
        'UNIQUE_VIOLATION',
        StatusCodes.CONFLICT,
        'Another record already has this value of a unique column.'
    ),

    // 422: the record breaks the schema
    VALIDATION_ERROR: define(
        'VALIDATION_ERROR',
        StatusCodes.UNPROCESSABLE_ENTITY,
        'The record does not match the collection schema.'
    ),
    REFERENCE_NOT_FOUND: define(
        'REFERENCE_NOT_FOUND',
        StatusCodes.UNPROCESSABLE_ENTITY,
        'A reference points to a record that does not exist.'
    ),

    // 500: broken configuration or data, or the engine is used incorrectly
    INVALID_CONFIG: define(
        'INVALID_CONFIG',
        StatusCodes.INTERNAL_SERVER_ERROR,
        'A config.json is invalid.'
    ),
    CORRUPT_RECORD: define(
        'CORRUPT_RECORD',
        StatusCodes.INTERNAL_SERVER_ERROR,
        'A record file cannot be read or has a wrong id.'
    ),
    CORRUPT_JOURNAL: define(
        'CORRUPT_JOURNAL',
        StatusCodes.INTERNAL_SERVER_ERROR,
        'The transaction journal cannot be recovered.'
    ),
    BROKEN_REFERENCES: define(
        'BROKEN_REFERENCES',
        StatusCodes.INTERNAL_SERVER_ERROR,
        'Stored records reference records that do not exist.'
    ),
    INVALID_TRANSACTION_USE: define(
        'INVALID_TRANSACTION_USE',
        StatusCodes.INTERNAL_SERVER_ERROR,
        'The database object was used inside a transaction instead of tx.'
    ),
    TRANSACTION_CLOSED: define(
        'TRANSACTION_CLOSED',
        StatusCodes.INTERNAL_SERVER_ERROR,
        'A transaction object was used after the transaction finished.'
    ),
    DATABASE_ALREADY_INITIALIZED: define(
        'DATABASE_ALREADY_INITIALIZED',
        StatusCodes.INTERNAL_SERVER_ERROR,
        'init() was called on a database that is open or being opened.'
    ),

    // 503: the database is temporarily unable to serve
    DATABASE_NOT_READY: define(
        'DATABASE_NOT_READY',
        StatusCodes.SERVICE_UNAVAILABLE,
        'init() has not finished yet.'
    ),
    DATABASE_CLOSED: define(
        'DATABASE_CLOSED',
        StatusCodes.SERVICE_UNAVAILABLE,
        'The database is closed or closing.'
    ),
    DATABASE_LOCKED: define(
        'DATABASE_LOCKED',
        StatusCodes.SERVICE_UNAVAILABLE,
        'The database directory is used by another running server.'
    ),
    DATABASE_NEEDS_RECOVERY: define(
        'DATABASE_NEEDS_RECOVERY',
        StatusCodes.SERVICE_UNAVAILABLE,
        'A disk failure interrupted a commit; a restart recovers it.'
    ),
    TRANSACTION_TIMEOUT: define(
        'TRANSACTION_TIMEOUT',
        StatusCodes.SERVICE_UNAVAILABLE,
        'A transaction took longer than its time limit and was rolled back.'
    ),
});

for (const [key, type] of Object.entries(DatabaseErrors)) {
    if (type.code !== key) {
        throw new Error(`DatabaseErrors.${key} has the code "${type.code}".`);
    }
}

const KNOWN_TYPES = new Set(Object.values(DatabaseErrors));

/**
 * Error raised by the storage engine.
 *
 * @example
 * throw new DatabaseError(DatabaseErrors.NOT_FOUND, 'Record not found.');
 * // error.code === 'NOT_FOUND', error.status === 404
 */
export class DatabaseError extends Error {
    /**
     * @param {DatabaseErrorType} type Entry of {@link DatabaseErrors}
     * @param {string} message Human-readable description of this occurrence
     */
    constructor(type, message) {
        if (!KNOWN_TYPES.has(type)) {
            throw new TypeError(
                'DatabaseError expects an entry of DatabaseErrors as its first argument.'
            );
        }
        super(message);
        this.name = 'DatabaseError';
        /** @type {string} Machine-readable code */
        this.code = type.code;
        /** @type {number} Suggested HTTP status */
        this.status = type.status;
    }
}
