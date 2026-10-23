import { promises as fs } from 'node:fs';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { DatabaseError } from './errors.js';
import { atomicWriteJson, removeFile } from './fs-utils.js';
import { LockManager, lockKey } from './lock-manager.js';
import { IndexManager } from './index-manager.js';
import { QueryContext } from './query-context.js';
import { Predicate } from './predicate.js';
import { collectRelations } from './relation-manager.js';
import {
    isPlainObject,
    isValidId,
    validateId,
    validateField,
    normalizeRecord,
} from './validator.js';

/**
 * Manages records, in-memory indexes, locking and persistence for a single collection.
 */
export class Collection {
    #name;
    #directory;
    #config;
    #records = new Set();
    #indexes;
    #locks;

    /**
     * @param {string} name Collection name
     * @param {string} directory Path to directory where JSON records reside
     * @param {object} config Collection configuration schema
     * @param {LockManager} [lockManager] Optional shared LockManager instance
     */
    constructor(name, directory, config, lockManager = null) {
        this.#name = name;
        this.#directory = directory;
        this.#config = config;
        // Reference columns are always indexed, so referrers can be found without reading files.
        const relations = collectRelations(name, config);
        const valueFields = new Set(config.indexes ?? []);
        const elementFields = [];
        for (const { field, many } of relations) {
            if (many) elementFields.push(field);
            else valueFields.add(field);
        }
        this.#indexes = new IndexManager([...valueFields], elementFields);
        this.#locks = lockManager ?? new LockManager();
    }

    /** @returns {string} */
    get name() {
        return this.#name;
    }

    /** @returns {string} */
    get directory() {
        return this.#directory;
    }

    /** @returns {object} */
    get config() {
        return this.#config;
    }

    /** @returns {Set<string>} */
    get records() {
        return this.#records;
    }

    /** @returns {IndexManager} */
    get indexes() {
        return this.#indexes;
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
     * @returns {Promise<void>}
     */
    async loadRecords() {
        const files = await fs.readdir(this.#directory, {
            withFileTypes: true,
        });
        for (const file of files) {
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
            this.#records.add(id);
            this.#indexes.indexRecord(record);
        }
    }

    /**
     * Creates a new record in the collection.
     * Generates a UUIDv7 primary key, normalizes fields, and writes atomically.
     * @param {object} input Request body
     * @param {object} [options]
     * @param {(record: object) => void} [options.beforeWrite] Extra validation of the normalized record
     * @returns {Promise<object>} The created record with generated id
     */
    async create(input, { beforeWrite } = {}) {
        if (!isPlainObject(input)) {
            throw new DatabaseError(
                'The request body must be a JSON object.',
                400,
                'INVALID_BODY'
            );
        }
        if (Object.hasOwn(input, 'id')) {
            throw new DatabaseError(
                'The "id" field is generated by the server.',
                422,
                'VALIDATION_ERROR'
            );
        }
        const record = normalizeRecord(this.#config.columns, input, true);
        beforeWrite?.(record);
        record.id = uuidv7();
        const filePath = this.#recordPath(record.id);
        await atomicWriteJson(filePath, record);
        this.#records.add(record.id);
        this.#indexes.indexRecord(record);
        return structuredClone(record);
    }

    /**
     * Retrieves a single record by UUID.
     * @param {string} id UUIDv7 of the record
     * @returns {Promise<object>}
     */
    async get(id) {
        validateId(id);
        if (!this.#records.has(id)) {
            throw new DatabaseError('Record not found.', 404, 'NOT_FOUND');
        }
        return await this.readRecord(id);
    }

    /**
     * Queries records with pagination, filtering (where object or Predicate).
     * @param {object} [options]
     * @param {object} [options.where] Legacy filter object
     * @param {Predicate} [options.predicate] Predicate chain
     * @param {number} [options.limit=100] Max items (1-500)
     * @param {number} [options.offset=0] Pagination offset (>= 0)
     * @returns {Promise<{ items: object[], total: number, limit: number, offset: number }>}
     */
    async list({ where = {}, predicate = null, limit = 100, offset = 0 } = {}) {
        if (
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 500 ||
            !Number.isInteger(offset) ||
            offset < 0
        ) {
            throw new DatabaseError(
                '"limit" must be 1–500 and "offset" must be zero or greater.',
                400,
                'INVALID_QUERY'
            );
        }

        let activePredicate;
        if (predicate) {
            activePredicate = predicate;
        } else {
            activePredicate = Predicate.fromWhere(
                where,
                this.#config.columns,
                validateField,
                DatabaseError,
                (id) => validateId(id)
            );
        }

        const context = new QueryContext(this);
        const candidateIds = await activePredicate.evaluate(context);
        const total = candidateIds.size;
        const sortedIds = Array.from(candidateIds).sort();
        const pageIds = sortedIds.slice(offset, offset + limit);
        const items = await Promise.all(
            pageIds.map((id) => context.getRecord(id))
        );

        return {
            items,
            total,
            limit,
            offset,
        };
    }

    /**
     * Updates an existing record by id.
     * @param {string} id
     * @param {object} changes
     * @param {object} [options]
     * @param {boolean} [options.replace=false] When true, replaces document (PUT); when false, merges (PATCH)
     * @param {(record: object) => void} [options.beforeWrite] Extra validation of the normalized record
     * @returns {Promise<object>} Updated record
     */
    async update(id, changes, { replace = false, beforeWrite } = {}) {
        validateId(id);
        if (!isPlainObject(changes)) {
            throw new DatabaseError(
                'The request body must be a JSON object.',
                400,
                'INVALID_BODY'
            );
        }
        if (Object.hasOwn(changes, 'id')) {
            throw new DatabaseError(
                'The "id" field cannot be changed.',
                422,
                'VALIDATION_ERROR'
            );
        }

        return this.#locks.withLock(lockKey(this.#name, id), async () => {
            if (!this.#records.has(id)) {
                throw new DatabaseError('Record not found.', 404, 'NOT_FOUND');
            }
            const previous = await this.readRecord(id);
            const merged = replace ? changes : { ...previous, ...changes };
            delete merged.id;
            const candidate = normalizeRecord(
                this.#config.columns,
                merged,
                replace
            );
            beforeWrite?.(candidate);
            candidate.id = id;
            await atomicWriteJson(this.#recordPath(id), candidate);
            this.#indexes.unindexRecord(previous);
            this.#indexes.indexRecord(candidate);
            return structuredClone(candidate);
        });
    }

    /**
     * Deletes a record by id.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async delete(id) {
        validateId(id);
        return this.#locks.withLock(lockKey(this.#name, id), async () => {
            if (!this.#records.has(id)) {
                throw new DatabaseError('Record not found.', 404, 'NOT_FOUND');
            }
            const previous = await this.readRecord(id);
            await removeFile(this.#recordPath(id));
            this.#records.delete(id);
            this.#indexes.unindexRecord(previous);
        });
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
        const previous = await this.#readIfKnown(record.id);
        await atomicWriteJson(this.#recordPath(record.id), record);
        if (previous) this.#indexes.unindexRecord(previous);
        this.#records.add(record.id);
        this.#indexes.indexRecord(record);
    }

    /**
     * Removes a record if it exists and updates indexes.
     * Used to apply committed changes; performs no validation and takes no locks.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async applyDelete(id) {
        validateId(id);
        const previous = await this.#readIfKnown(id);
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
