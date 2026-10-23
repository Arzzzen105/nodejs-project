import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseError } from './errors.js';
import { Collection } from './collection.js';
import { LockManager, lockKey } from './lock-manager.js';
import { IndexManager } from './index-manager.js';
import { QueryContext } from './query-context.js';
import { RelationManager } from './relation-manager.js';
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
    RelationManager,
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

// How many times delete() re-plans when new referrers appear while it waits for locks.
const MAX_DELETE_ATTEMPTS = 3;

/**
 * @typedef {object} DeleteReport
 * @property {Array<{ collection: string, id: string }>} deleted Deleted records
 * @property {Array<{ collection: string, id: string, fields: string[] }>} updated
 *   Records whose references were nulled or removed by `onDelete` rules
 */

/**
 * FileDatabase facade coordinating multiple collections, schemas, relations and persistence.
 */
export class FileDatabase {
    #root;
    #collections = new Map();
    #relations = new RelationManager(new Map());
    #locks = new LockManager();
    #initialized = false;
    #resolve = (name) => this.#collections.get(name);

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
     * Initializes the database: reads and validates all collection configs,
     * builds the relation graph, loads records and verifies stored references.
     * @returns {Promise<FileDatabase>}
     */
    async init() {
        await fs.mkdir(this.#root, { recursive: true });
        const configs = await this.#readConfigs();

        const relations = new RelationManager(
            new Map([...configs].map(([name, { config }]) => [name, config]))
        );

        const collections = new Map();
        for (const [name, { directory, config }] of configs) {
            const collection = new Collection(
                name,
                directory,
                config,
                this.#locks
            );
            await collection.loadRecords();
            collections.set(name, collection);
        }
        relations.checkIntegrity((name) => collections.get(name));

        this.#relations = relations;
        this.#collections = collections;
        this.#initialized = true;
        return this;
    }

    /**
     * Reads and validates `config.json` of every collection directory.
     * @returns {Promise<Map<string, { directory: string, config: object }>>}
     */
    async #readConfigs() {
        const configs = new Map();
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
            configs.set(name, { directory, config });
        }
        return configs;
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
        const collection = this.#collection(name);
        return this.#locks.withLocks(
            this.#relations.targetLockKeys(name, input),
            () =>
                collection.create(input, {
                    beforeWrite: (record) =>
                        this.#relations.validateReferences(
                            name,
                            record,
                            this.#resolve
                        ),
                })
        );
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
    async update(name, id, changes, options = {}) {
        const collection = this.#collection(name);
        return this.#locks.withLocks(
            [
                lockKey(name, id),
                ...this.#relations.targetLockKeys(name, changes),
            ],
            () =>
                collection.update(id, changes, {
                    ...options,
                    beforeWrite: (record) =>
                        this.#relations.validateReferences(
                            name,
                            record,
                            this.#resolve
                        ),
                })
        );
    }

    /**
     * Deletes a record by id and applies `onDelete` rules of references pointing to it.
     * Referencing records are updated first and the record itself is deleted last,
     * so a crash in between never leaves a reference to a missing record.
     * @param {string} name Collection name
     * @param {string} id Record UUID
     * @returns {Promise<DeleteReport>}
     */
    async delete(name, id) {
        this.#collection(name);
        validateId(id);

        for (let attempt = 0; attempt < MAX_DELETE_ATTEMPTS; attempt++) {
            const keys = [
                lockKey(name, id),
                ...this.#relations.referrerLockKeys(name, id, this.#resolve),
            ];
            const report = await this.#locks.withLocks(keys, () =>
                this.#deleteLocked(name, id, new Set(keys))
            );
            if (report) return report;
        }
        throw new DatabaseError(
            'The record is being modified concurrently, try again.',
            409,
            'CONCURRENT_MODIFICATION'
        );
    }

    /**
     * Performs the delete while holding locks on the record and its referrers.
     * @returns {Promise<DeleteReport|null>} null if referrers changed and the delete must be re-planned
     */
    async #deleteLocked(name, id, lockedKeys) {
        const current = this.#relations.referrerLockKeys(
            name,
            id,
            this.#resolve
        );
        if (current.some((key) => !lockedKeys.has(key))) return null;

        const collection = this.#collections.get(name);
        if (!collection.has(id)) {
            throw new DatabaseError('Record not found.', 404, 'NOT_FOUND');
        }

        const plan = this.#relations.planDelete(name, id, this.#resolve);
        const updated = [];
        for (const change of plan) {
            const referrer = this.#collections.get(change.collection);
            const patch = {};
            for (const field of change.setNull) patch[field] = null;
            if (change.remove.length > 0) {
                const record = await referrer.readRecord(change.id);
                for (const field of change.remove) {
                    patch[field] = record[field].filter(
                        (value) => value !== id
                    );
                }
            }
            await referrer.update(change.id, patch);
            updated.push({
                collection: change.collection,
                id: change.id,
                fields: [...change.setNull, ...change.remove],
            });
        }

        await collection.delete(id);
        return { deleted: [{ collection: name, id }], updated };
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
