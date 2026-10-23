import { promises as fs } from 'node:fs';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { DatabaseError } from './errors.js';
import { atomicWriteJson, removeFile } from './fs-utils.js';
import { IndexManager } from './index-manager.js';
import { executeGet, executeList } from './query-context.js';
import { collectRelations } from './relation-manager.js';
import {
    isPlainObject,
    isValidId,
    validateId,
    normalizeRecord,
} from './validator.js';

// Leftover of an atomic write interrupted before its rename: `<id>.json.<uuid>.tmp`.
const TEMPORARY_RECORD_FILE = /\.json\.[^.]+\.tmp$/;

/**
 * @typedef {object} LoadWarning
 * @property {'INVALID_RECORD'} code
 * @property {string} collection
 * @property {string} id
 * @property {string} message What is wrong with the record
 */

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
            'The request body must be a JSON object.',
            400,
            'INVALID_BODY'
        );
    }
    if (Object.hasOwn(input, 'id')) {
        throw new DatabaseError(idMessage, 422, 'VALIDATION_ERROR');
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

    /**
     * @param {string} name Collection name
     * @param {string} directory Path to directory where JSON records reside
     * @param {object} config Collection configuration schema
     */
    constructor(name, directory, config) {
        this.#name = name;
        this.#directory = directory;
        this.#config = deepFreeze(structuredClone(config));
        // Reference columns are always indexed, so referrers can be found without reading files.
        const relations = collectRelations(name, config);
        const valueFields = new Set(config.indexes ?? []);
        const elementFields = [];
        for (const { field, many } of relations) {
            if (many) elementFields.push(field);
            else valueFields.add(field);
        }
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
     * @param {{ gt?: *, gte?: *, lt?: *, lte?: * }} range
     * @returns {Set<string>|null}
     */
    lookupRangeIndex(field, range) {
        return this.#indexes.lookupRange(field, range);
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
                    `Cannot read ${this.#name}/${file.name}: ${error.message}`,
                    500,
                    'CORRUPT_RECORD'
                );
            }
            if (!isPlainObject(record) || record.id !== id) {
                throw new DatabaseError(
                    `Record ${this.#name}/${file.name} has an invalid id.`,
                    500,
                    'CORRUPT_RECORD'
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
     * @param {object} record
     * @returns {string|null} First schema violation of a stored record, if any
     */
    schemaProblem(record) {
        const fields = { ...record };
        delete fields.id;
        try {
            normalizeRecord(this.#config.columns, fields, false);
            return null;
        } catch (error) {
            return error.message;
        }
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
        const record = normalizeRecord(this.#config.columns, input, true);
        record.id = uuidv7();
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
        return candidate;
    }

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
                    'Record not found on disk. Restart the server to rebuild its indexes.',
                    404,
                    'NOT_FOUND'
                );
            }
            throw new DatabaseError(
                `Cannot read ${this.#name}/${id}.json: ${error.message}`,
                500,
                'CORRUPT_RECORD'
            );
        }
    }

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
