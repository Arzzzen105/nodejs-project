import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseError } from './errors.js';
import { Collection } from './collection.js';
import { LockManager } from './lock-manager.js';
import { IndexManager } from './index-manager.js';
import { QueryContext } from './query-context.js';
import {
    Predicate,
    eq,
    ne,
    gt,
    gte,
    lt,
    lte,
    range,
    inList,
    and,
    or,
    custom,
    all,
} from './predicate.js';
import {
    COLLECTION_NAME,
    validateConfig,
    validateField,
    normalizeRecord,
    validateId,
    isValidId,
} from './validator.js';

export {
    DatabaseError,
    Collection,
    LockManager,
    IndexManager,
    QueryContext,
    Predicate,
    eq,
    ne,
    gt,
    gte,
    lt,
    lte,
    range,
    inList,
    and,
    or,
    custom,
    all,
    COLLECTION_NAME,
    validateConfig,
    validateField,
    normalizeRecord,
    validateId,
    isValidId,
};

/**
 * FileDatabase facade coordinating multiple collections, schemas, and persistence.
 */
export class FileDatabase {
    #root;
    #collections = new Map();
    #locks = new LockManager();
    #initialized = false;

    /**
     * @param {string} [root] Base directory for database collections
     */
    constructor(
        root = process.env.DATABASE_DIR ??
            path.resolve(process.cwd(), 'database')
    ) {
        this.#root = path.resolve(root);
    }

    /**
     * Initializes the database by scanning subdirectories and loading collections.
     * @returns {Promise<FileDatabase>}
     */
    async init() {
        await fs.mkdir(this.#root, { recursive: true });
        const entries = await fs.readdir(this.#root, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const name = entry.name;
            if (!COLLECTION_NAME.test(name)) continue;

            const directory = path.join(this.#root, name);
            let config;
            try {
                config = JSON.parse(
                    await fs.readFile(
                        path.join(directory, 'config.json'),
                        'utf8'
                    )
                );
            } catch (error) {
                if (error.code === 'ENOENT') continue;
                throw new DatabaseError(
                    `Cannot read config for "${name}": ${error.message}`,
                    500,
                    'INVALID_CONFIG'
                );
            }

            validateConfig(name, config);

            const collection = new Collection(
                name,
                directory,
                config,
                this.#locks
            );
            await collection.loadRecords();
            this.#collections.set(name, collection);
        }

        this.#initialized = true;
        return this;
    }

    /**
     * Returns a list of all active collection names.
     * @returns {string[]}
     */
    collections() {
        this.#assertInitialized();
        return [...this.#collections.keys()];
    }

    /**
     * Returns the schema for a collection.
     * @param {string} name Collection name
     * @returns {object} Deep clone of schema config
     */
    schema(name) {
        return this.#collection(name).schema();
    }

    /**
     * Creates a new record in the specified collection.
     * @param {string} name Collection name
     * @param {object} input Record data
     * @returns {Promise<object>} Created record with id
     */
    async create(name, input) {
        return this.#collection(name).create(input);
    }

    /**
     * Retrieves a record by id from the specified collection.
     * @param {string} name Collection name
     * @param {string} id Record UUID
     * @returns {Promise<object>}
     */
    async get(name, id) {
        return this.#collection(name).get(id);
    }

    /**
     * Lists records with pagination and filtering.
     * @param {string} name Collection name
     * @param {object} [options] Query options (where, predicate, limit, offset)
     * @returns {Promise<{ items: object[], total: number, limit: number, offset: number }>}
     */
    async list(name, options) {
        return this.#collection(name).list(options);
    }

    /**
     * Updates an existing record.
     * @param {string} name Collection name
     * @param {string} id Record UUID
     * @param {object} changes Changes to apply
     * @param {object} [options] Update options ({ replace: boolean })
     * @returns {Promise<object>} Updated record
     */
    async update(name, id, changes, options) {
        return this.#collection(name).update(id, changes, options);
    }

    /**
     * Deletes a record by id.
     * @param {string} name Collection name
     * @param {string} id Record UUID
     * @returns {Promise<void>}
     */
    async delete(name, id) {
        return this.#collection(name).delete(id);
    }

    #collection(name) {
        this.#assertInitialized();
        if (typeof name !== 'string' || !COLLECTION_NAME.test(name)) {
            throw new DatabaseError(
                'Invalid collection name.',
                400,
                'INVALID_COLLECTION'
            );
        }
        const collection = this.#collections.get(name);
        if (!collection) {
            throw new DatabaseError(
                `Unknown collection "${name}".`,
                404,
                'COLLECTION_NOT_FOUND'
            );
        }
        return collection;
    }

    #assertInitialized() {
        if (!this.#initialized) {
            throw new DatabaseError(
                'File database is not initialized.',
                503,
                'DATABASE_NOT_READY'
            );
        }
    }
}
