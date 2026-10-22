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

    constructor(
        root = process.env.DATABASE_DIR ??
            path.resolve(process.cwd(), 'database')
    ) {
        this.#root = path.resolve(root);
    }

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

    collections() {
        this.#assertInitialized();
        return [...this.#collections.keys()];
    }

    schema(name) {
        return this.#collection(name).schema();
    }

    async create(name, input) {
        return this.#collection(name).create(input);
    }

    async get(name, id) {
        return this.#collection(name).get(id);
    }

    async list(name, options) {
        return this.#collection(name).list(options);
    }

    async update(name, id, changes, options) {
        return this.#collection(name).update(id, changes, options);
    }

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
