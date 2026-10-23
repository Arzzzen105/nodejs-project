import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseError } from './errors.js';
import { Collection } from './collection.js';
import { Journal } from './journal.js';
import { TransactionManager } from './transaction-manager.js';
import { Transaction } from './transaction.js';
import { LockManager } from './lock-manager.js';
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
    Journal,
    Transaction,
    TransactionManager,
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
 * Applies changes of an interrupted commit found in the journal.
 * @param {import('./journal.js').JournalChange[]} changes
 * @param {Map<string, Collection>} collections
 */
async function applyJournal(changes, collections) {
    for (const { collection: name, id, record } of changes) {
        const collection = collections.get(name);
        if (
            !collection ||
            !isValidId(id) ||
            (record !== null && record.id !== id)
        ) {
            throw new DatabaseError(
                `Cannot recover the transaction journal: invalid change for ${name}/${id}.`,
                500,
                'CORRUPT_JOURNAL'
            );
        }
        if (record === null) await collection.applyDelete(id);
        else await collection.applyPut(record);
    }
}

/**
 * @typedef {import('./transaction.js').DeleteReport} DeleteReport
 */

/**
 * FileDatabase facade coordinating multiple collections, schemas, relations and persistence.
 */
export class FileDatabase {
    #root;
    #collections = new Map();
    #transactions = null;
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
     * Initializes the database: reads and validates all collection configs,
     * builds the relation graph, loads records, finishes an interrupted commit
     * from the journal and verifies stored references.
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
            const collection = new Collection(name, directory, config);
            await collection.loadRecords();
            collections.set(name, collection);
        }

        const journal = new Journal(this.#root);
        const pending = await journal.recover();
        if (pending) await applyJournal(pending, collections);

        relations.checkIntegrity((name) => collections.get(name));
        if (pending) await journal.clear();

        this.#collections = collections;
        this.#transactions = new TransactionManager({
            journal,
            collection: (name) => this.#collection(name),
            relations,
        });
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
     * Runs as a single-operation transaction.
     * @param {string} name Collection name
     * @param {object} input Record data
     * @returns {Promise<object>} Created record with id
     */
    async create(name, input) {
        this.#assertOutsideTransaction('create');
        this.#collection(name);
        return this.#transactions.run((tx) => tx.create(name, input));
    }

    /**
     * Runs `body` as one atomic, fully isolated transaction.
     * Inside the body use the transaction object (`tx.create`, `tx.get`, ...);
     * calling this database directly there throws INVALID_TRANSACTION_USE.
     * - resolves with the body's result once all changes are committed;
     * - `tx.rollback(value)` discards all changes and resolves with `value`;
     * - if the body throws, all changes are discarded and the error is rethrown.
     * @template T
     * @param {(tx: Transaction) => Promise<T>} body
     * @returns {Promise<T>}
     */
    async transaction(body) {
        this.#assertInitialized();
        this.#assertOutsideTransaction('transaction');
        return this.#transactions.run(body);
    }

    /**
     * Retrieves a record by id from the specified collection.
     * @param {string} name Collection name
     * @param {string} id Record UUID
     * @returns {Promise<object>}
     */
    async get(name, id) {
        this.#assertOutsideTransaction('get');
        const collection = this.#collection(name);
        return this.#transactions.read(() => collection.get(id));
    }

    /**
     * Lists records with pagination and filtering.
     * @param {string} name Collection name
     * @param {object} [options] Query options (where, predicate, limit, offset)
     * @returns {Promise<{ items: object[], total: number, limit: number, offset: number }>}
     */
    async list(name, options) {
        this.#assertOutsideTransaction('list');
        const collection = this.#collection(name);
        return this.#transactions.read(() => collection.list(options));
    }

    /**
     * Updates an existing record.
     * Runs as a single-operation transaction.
     * @param {string} name Collection name
     * @param {string} id Record UUID
     * @param {object} changes Changes to apply
     * @param {object} [options] Update options ({ replace: boolean })
     * @returns {Promise<object>} Updated record
     */
    async update(name, id, changes, options) {
        this.#assertOutsideTransaction('update');
        this.#collection(name);
        return this.#transactions.run((tx) =>
            tx.update(name, id, changes, options)
        );
    }

    /**
     * Deletes a record by id and applies `onDelete` rules of references pointing to it.
     * Runs as a single transaction, so the record and all reference updates are
     * committed atomically.
     * @param {string} name Collection name
     * @param {string} id Record UUID
     * @returns {Promise<DeleteReport>}
     */
    async delete(name, id) {
        this.#assertOutsideTransaction('delete');
        this.#collection(name);
        return this.#transactions.run((tx) => tx.delete(name, id));
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

    #assertOutsideTransaction(method) {
        if (this.#transactions?.current) {
            throw new DatabaseError(
                `db.${method}() cannot be used inside a transaction, use the transaction object (tx.${method}) instead.`,
                500,
                'INVALID_TRANSACTION_USE'
            );
        }
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
