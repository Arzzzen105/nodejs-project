import { promises as fs } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { DatabaseError, DatabaseErrors } from './errors.js';
import { atomicWriteJson, removeFile } from './fs-utils.js';
import { IndexManager } from './index-manager.js';
import { executeGet, executeList } from './query-context.js';
import { collectRelations } from './relation-manager.js';
import { normalizeDatetime } from './dates.js';
import {
    TIMESTAMP_COLUMNS,
    isPlainObject,
    isValidId,
    validateId,
    normalizeRecord,
} from './validator.js';

// Leftover of an atomic write interrupted before its rename: `<id>.json.<uuid>.tmp`.
const TEMPORARY_RECORD_FILE = /\.json\.[^.]+\.tmp$/;

/**
 * @typedef {object} LoadWarning
 * @property {'INVALID_RECORD'|'DUPLICATE_VALUE'} code
 * @property {string} collection
 * @property {string} id
 * @property {string} message What is wrong with the record
 */

/**
 * Moment a UUIDv7 was generated: its first 48 bits are Unix time in milliseconds.
 * @param {string} id
 * @returns {string} Canonical datetime
 */
function idTimestamp(id) {
    const millis = parseInt(id.replaceAll('-', '').slice(0, 12), 16);
    return new Date(millis).toISOString();
}

/**
 * Freezes an object and everything it contains.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
    if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}

/**
 * Rejects bodies that are not plain objects or try to set the primary key.
 * @param {*} input
 * @param {string} idMessage Error message when the body contains "id"
 */
export function assertWritableBody(input, idMessage) {
    if (!isPlainObject(input)) {
        throw new DatabaseError(
            DatabaseErrors.INVALID_BODY,
            'The request body must be a JSON object.'
        );
    }
    if (Object.hasOwn(input, 'id')) {
        throw new DatabaseError(DatabaseErrors.VALIDATION_ERROR, idMessage);
    }
}

/**
 * Manages records, in-memory indexes, locking and persistence for a single collection.
 */
export class Collection {
    #name;
    #directory;
    #config;
    #records = new Set();
    #indexes;
    #queryColumns;
    #managedFields;

    /**
     * @param {string} name Collection name
     * @param {string} directory Path to directory where JSON records reside
     * @param {object} config Collection configuration schema
     */
    constructor(name, directory, config) {
        this.#name = name;
        this.#directory = directory;
        this.#config = deepFreeze(structuredClone(config));
        this.#managedFields = config.timestamps
            ? Object.keys(TIMESTAMP_COLUMNS)
            : [];
        this.#queryColumns = config.timestamps
            ? Object.freeze({ ...this.#config.columns, ...TIMESTAMP_COLUMNS })
            : this.#config.columns;
        // Reference and unique columns are always indexed, so referrers and taken
        // values can be found without reading files.
        const relations = collectRelations(name, config);
        const valueFields = new Set(config.indexes ?? []);
        const elementFields = [];
        for (const { field, many } of relations) {
            if (many) elementFields.push(field);
            else valueFields.add(field);
        }
        for (const field of this.uniqueFields()) valueFields.add(field);
        this.#indexes = new IndexManager([...valueFields], elementFields);
    }

    /** @returns {string} */
    get name() {
        return this.#name;
    }

    /**
     * Read-only view of the collection config.
     * @returns {object}
     */
    get config() {
        return this.#config;
    }

    /**
     * Columns available to filters and sorting: the config columns plus
     * createdAt/updatedAt when "timestamps" is on.
     * @returns {object}
     */
    get queryColumns() {
        return this.#queryColumns;
    }

    /**
     * @returns {Set<string>} Copy of all record ids
     */
    ids() {
        return new Set(this.#records);
    }

    /**
     * Checks if a column is indexed.
     * @param {string} field
     * @returns {boolean}
     */
    hasIndex(field) {
        return this.#indexes.hasIndex(field);
    }

    /**
     * Checks whether a record with the id exists.
     * @param {string} id
     * @returns {boolean}
     */
    has(id) {
        return this.#records.has(id);
    }

    /**
     * Finds records whose reference column points to the given id.
     * @param {string} field Reference column (scalar or array)
     * @param {string} id Referenced record id
     * @returns {Set<string>}
     */
    findReferrers(field, id) {
        const matches = this.#indexes.hasElementIndex(field)
            ? this.#indexes.lookupElement(field, id)
            : this.#indexes.lookup(field, id);
        return matches ?? new Set();
    }

    /**
     * Lists every stored value of a reference column with the ids holding it.
     * @param {string} field
     * @returns {Array<{ value: *, ids: Set<string> }>}
     */
    referenceEntries(field) {
        return this.#indexes.entries(field) ?? [];
    }

    /**
     * Looks up matching IDs by exact value in the index.
     * @param {string} field
     * @param {*} value
     * @returns {Set<string>|null}
     */
    lookupIndex(field, value) {
        return this.#indexes.lookup(field, value);
    }

    /**
     * Looks up matching IDs for a list of values (IN operator).
     * @param {string} field
     * @param {Array<*>} values
     * @returns {Set<string>|null}
     */
    lookupInIndex(field, values) {
        return this.#indexes.lookupIn(field, values);
    }

    /**
     * Looks up matching IDs for range bounds.
     * @param {string} field
     * @param {import('./predicate.js').RangeBounds} bounds
     * @returns {Set<string>|null}
     */
    lookupRangeIndex(field, bounds) {
        return this.#indexes.lookupRange(field, bounds);
    }

    /**
     * Returns a deep clone of the collection schema.
     * @returns {object}
     */
    schema() {
        return structuredClone(this.#config);
    }

    /**
     * Loads all records from disk and builds in-memory indexes.
     * Removes temporary files of interrupted writes. Records that do not match the
     * current schema (e.g. written before a schema change) are still loaded and
     * reported as warnings; unreadable records fail the load.
     * @returns {Promise<LoadWarning[]>}
     */
    async loadRecords() {
        const files = await fs.readdir(this.#directory, {
            withFileTypes: true,
        });
        const warnings = [];
        for (const file of files) {
            if (file.isFile() && TEMPORARY_RECORD_FILE.test(file.name)) {
                await fs.rm(path.join(this.#directory, file.name), {
                    force: true,
                });
                continue;
            }
            if (
                !file.isFile() ||
                !file.name.endsWith('.json') ||
                file.name === 'config.json'
            ) {
                continue;
            }
            const id = file.name.slice(0, -5);
            if (!isValidId(id)) continue;

            let record;
            try {
                record = JSON.parse(
                    await fs.readFile(
                        path.join(this.#directory, file.name),
                        'utf8'
                    )
                );
            } catch (error) {
                throw new DatabaseError(
                    DatabaseErrors.CORRUPT_RECORD,
                    `Cannot read ${this.#name}/${file.name}: ${error.message}`
                );
            }
            if (!isPlainObject(record) || record.id !== id) {
                throw new DatabaseError(
                    DatabaseErrors.CORRUPT_RECORD,
                    `Record ${this.#name}/${file.name} has an invalid id.`
                );
            }
            const problem = this.schemaProblem(record);
            if (problem) {
                warnings.push({
                    code: 'INVALID_RECORD',
                    collection: this.#name,
                    id,
                    message: problem,
                });
            }
            this.#records.add(id);
            this.#indexes.indexRecord(record);
        }
        return warnings;
    }

    /**
     * Columns declared with `unique: true`.
     * @returns {string[]}
     */
    uniqueFields() {
        return Object.entries(this.#config.columns)
            .filter(([, definition]) => definition.unique)
            .map(([field]) => field);
    }

    /**
     * Records sharing a value of a unique column, e.g. after `unique` was added
     * to a column that already had data. Null values never count as duplicates.
     * @returns {LoadWarning[]}
     */
    duplicateWarnings() {
        const warnings = [];
        for (const field of this.uniqueFields()) {
            for (const { value, ids } of this.#indexes.entries(field)) {
                if (value === null || ids.size < 2) continue;
                for (const id of ids) {
                    warnings.push({
                        code: 'DUPLICATE_VALUE',
                        collection: this.#name,
                        id,
                        message: `"${field}" must be unique, but ${ids.size - 1} other record(s) have the same value.`,
                    });
                }
            }
        }
        return warnings;
    }

    /**
     * @param {object} record
     * @returns {string|null} First schema violation of a stored record, if any
     */
    schemaProblem(record) {
        const fields = { ...record };
        delete fields.id;
        for (const field of this.#managedFields) {
            if (
                Object.hasOwn(fields, field) &&
                normalizeDatetime(fields[field]) !== fields[field]
            ) {
                return `"${field}" must be a datetime in the canonical UTC form.`;
            }
            delete fields[field];
        }
        let normalized;
        try {
            normalized = normalizeRecord(this.#config.columns, fields, false);
        } catch (error) {
            return error.message;
        }
        // e.g. an edited file: a datetime out of canonical form breaks time order
        for (const [field, value] of Object.entries(fields)) {
            if (normalized[field] !== value && typeof value === 'string') {
                // the value itself is left out: messages are logged and dates may be personal
                return `"${field}" is not stored in the canonical UTC form.`;
            }
        }
        return null;
    }

    /**
     * Builds a new record from request input without storing it:
     * validates the body, applies defaults and generates a UUIDv7 primary key.
     * Does not touch the disk or the collection state.
     * @param {object} input Request body
     * @returns {object} Normalized record with id
     */
    prepareCreate(input) {
        assertWritableBody(input, 'The "id" field is generated by the server.');
        this.#assertNotManaged(input);
        const record = normalizeRecord(this.#config.columns, input, true);
        record.id = uuidv7();
        if (this.#config.timestamps) {
            const now = new Date().toISOString();
            record.createdAt = now;
            record.updatedAt = now;
        }
        return record;
    }

    /**
     * Builds the next version of a record without storing it.
     * Does not touch the disk or the collection state.
     * @param {object} previous Current record
     * @param {object} changes Request body
     * @param {object} [options]
     * @param {boolean} [options.replace=false] When true, replaces document (PUT); when false, merges (PATCH)
     * @returns {object} Normalized record with the same id
     */
    prepareUpdate(previous, changes, options) {
        const { replace = false } = options ?? {};
        assertWritableBody(changes, 'The "id" field cannot be changed.');
        this.#assertNotManaged(changes);
        // Fields dropped from the schema are left behind by PATCH instead of making
        // every update of an old record fail with "Unknown field".
        const kept = replace ? {} : this.#knownFields(previous);
        const merged = { ...kept, ...changes };
        delete merged.id;
        const candidate = normalizeRecord(
            this.#config.columns,
            merged,
            replace
        );
        candidate.id = previous.id;
        this.#stamp(previous, candidate);
        return candidate;
    }

    /**
     * Builds the next version of a record changed by an `onDelete` rule
     * (`setNull` or `remove`) without storing it.
     *
     * Unlike {@link Collection#prepareUpdate}, the record is not validated. The
     * rule only clears references to the deleted record, which is valid by
     * construction: `setNull` needs a nullable column and `remove` keeps the
     * other ids. Nobody asked to edit this record, so a problem in its other
     * fields (e.g. a column that became required later, already reported as a
     * warning on start) must not block a delete in another collection. The
     * rest of the record is kept as it is.
     * @param {object} previous Current record
     * @param {object} patch Reference fields and their new values
     * @returns {object} The record with the same id
     */
    prepareReferenceCleanup(previous, patch) {
        const candidate = { ...previous, ...patch, id: previous.id };
        this.#stamp(previous, candidate);
        return candidate;
    }

    /**
     * Sets createdAt/updatedAt of an updated record, if the collection has
     * timestamps; updatedAt moves only when something else changed.
     * @param {object} previous
     * @param {object} candidate Changed in place
     */
    #stamp(previous, candidate) {
        if (!this.#config.timestamps) return;
        // records stored before "timestamps" was turned on have no createdAt,
        // but their UUIDv7 id carries the moment they were created
        const createdAt = previous.createdAt ?? idTimestamp(previous.id);
        const changed = !isDeepStrictEqual(
            this.#withoutManaged(previous),
            this.#withoutManaged(candidate)
        );
        candidate.createdAt = createdAt;
        candidate.updatedAt = changed
            ? new Date().toISOString()
            : (previous.updatedAt ?? createdAt);
    }

    /**
     * @param {object} record
     * @returns {object} The record without createdAt/updatedAt
     */
    #withoutManaged(record) {
        const copy = { ...record };
        for (const field of this.#managedFields) delete copy[field];
        return copy;
    }

    /**
     * Rejects request bodies that try to set fields the database manages.
     * @param {object} input
     */
    #assertNotManaged(input) {
        const field = this.#managedFields.find((name) =>
            Object.hasOwn(input, name)
        );
        if (field !== undefined) {
            throw new DatabaseError(
                DatabaseErrors.VALIDATION_ERROR,
                `The "${field}" field is managed by the database.`
            );
        }
    }

    /**
     * @param {object} record
     * @returns {object} Fields of the record that the schema still declares
     */
    #knownFields(record) {
        return Object.fromEntries(
            Object.entries(record).filter(([field]) =>
                Object.hasOwn(this.#config.columns, field)
            )
        );
    }

    /**
     * Retrieves a single record by UUID.
     * @param {string} id UUIDv7 of the record
     * @returns {Promise<object>}
     */
    async get(id) {
        return executeGet(this, id);
    }

    /**
     * Queries records with pagination, filtering (where object or Predicate).
     * @param {object} [options]
     * @param {object} [options.where] Legacy filter object
     * @param {import('./predicate.js').Predicate} [options.predicate] Predicate chain
     * @param {string|string[]} [options.sort] e.g. "lastName", "-age" or "lastName,-age"
     * @param {number} [options.limit=100] Max items (1-500)
     * @param {number} [options.offset=0] Pagination offset (>= 0)
     * @returns {Promise<{ items: object[], total: number, limit: number, offset: number }>}
     */
    async list(options) {
        return executeList(this, options);
    }

    /**
     * Reads and parses a record JSON from disk.
     * @param {string} id
     * @returns {Promise<object>}
     */
    async readRecord(id) {
        try {
            return JSON.parse(await fs.readFile(this.#recordPath(id), 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new DatabaseError(
                    DatabaseErrors.NOT_FOUND,
                    'Record not found on disk. Restart the server to rebuild its indexes.'
                );
            }
            throw new DatabaseError(
                DatabaseErrors.CORRUPT_RECORD,
                `Cannot read ${this.#name}/${id}.json: ${error.message}`
            );
        }
    }

    /**
     * @param {string} id
     * @returns {string} Path of the record file
     */
    #recordPath(id) {
        return path.join(this.#directory, `${id}.json`);
    }

    /**
     * Stores a complete, already validated record and updates indexes.
     * Used to apply committed changes; performs no validation and takes no locks.
     * @param {object} record Record with an `id`
     * @returns {Promise<void>}
     */
    async applyPut(record) {
        validateId(record.id);
        await this.#store(record, await this.#readIfKnown(record.id));
    }

    /**
     * Removes a record if it exists and updates indexes.
     * Used to apply committed changes; performs no validation and takes no locks.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async applyDelete(id) {
        validateId(id);
        await this.#remove(id, await this.#readIfKnown(id));
    }

    /**
     * The only place that writes record files: stores the record and moves it in indexes.
     * @param {object} record New record
     * @param {object|null} previous Stored version of the record, if any
     */
    async #store(record, previous) {
        await atomicWriteJson(this.#recordPath(record.id), record);
        if (previous) this.#indexes.unindexRecord(previous);
        this.#records.add(record.id);
        this.#indexes.indexRecord(record);
    }

    /**
     * The only place that removes record files.
     * @param {string} id
     * @param {object|null} previous Stored version of the record, if any
     */
    async #remove(id, previous) {
        await removeFile(this.#recordPath(id));
        this.#records.delete(id);
        if (previous) this.#indexes.unindexRecord(previous);
    }

    /**
     * Reads a record known to the collection, tolerating a file that is already gone.
     * @param {string} id
     * @returns {Promise<object|null>}
     */
    async #readIfKnown(id) {
        if (!this.#records.has(id)) return null;
        try {
            return await this.readRecord(id);
        } catch (error) {
            if (error.code === 'NOT_FOUND') return null;
            throw error;
        }
    }
}
