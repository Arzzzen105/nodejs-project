import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseError } from './errors.js';
import { Collection } from './collection.js';
import { Journal } from './journal.js';
import { ProcessLock } from './process-lock.js';
import { RelationManager } from './relation-manager.js';
import { TransactionManager } from './transaction-manager.js';
import { COLLECTION_NAME, validateConfig, isValidId } from './validator.js';

// Public API of the storage engine. Everything else in src/storage is internal.
export { DatabaseError };
export {
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
 * @typedef {import('./collection.js').LoadWarning} LoadWarning
 */

/** @param {LoadWarning} warning */
function defaultWarningHandler(warning) {
    console.warn(
        `[file-database] ${warning.collection}/${warning.id}: ${warning.message}`
    );
}

/**
 * FileDatabase facade coordinating multiple collections, schemas, relations and persistence.
 */
export class FileDatabase {
    #root;
    #onWarning;
    #collections = new Map();
    #transactions = null;
    #warnings = [];
    #transactionTimeout;
    #lock = null;
    #initialized = false;
    #closed = false;

    /**
     * @param {string} [root] Base directory for database collections
     * @param {object} [options]
     * @param {(warning: LoadWarning) => void} [options.onWarning] Called for every
     *   problem found during init that does not stop the database (default: console.warn)
     * @param {number} [options.transactionTimeout=10000] Max duration of a transaction
     *   body in milliseconds; 0 disables the limit
     */
    constructor(
        root = process.env.DATABASE_DIR ??
            path.resolve(process.cwd(), 'database'),
        { onWarning = defaultWarningHandler, transactionTimeout = 10000 } = {}
    ) {
        if (!Number.isFinite(transactionTimeout) || transactionTimeout < 0) {
            throw new TypeError(
                '"transactionTimeout" must be a non-negative number of milliseconds.'
            );
        }
        this.#root = path.resolve(root);
        this.#onWarning = onWarning;
        this.#transactionTimeout = transactionTimeout;
    }

    /**
     * Problems found by the last init that did not stop the database,
     * e.g. records that do not match the current schema.
     * @returns {LoadWarning[]}
     */
    get warnings() {
        return structuredClone(this.#warnings);
    }

    /**
     * Initializes the database: reads and validates all collection configs,
     * builds the relation graph, loads records, finishes an interrupted commit
     * from the journal and verifies stored references.
     * @returns {Promise<FileDatabase>}
     */
    async init() {
        if (this.#initialized) {
            throw new DatabaseError(
                'The database is already initialized.',
                500,
                'DATABASE_ALREADY_INITIALIZED'
            );
        }
        await fs.mkdir(this.#root, { recursive: true });
        const lock = new ProcessLock(this.#root);
        await lock.acquire();
        try {
            await this.#load();
        } catch (error) {
            await lock.release();
            throw error;
        }
        this.#lock = lock;
        this.#closed = false;
        this.#initialized = true;
        for (const warning of this.#warnings) this.#onWarning(warning);
        return this;
    }

    /**
     * Waits for the running transaction and reads, then releases the database
     * directory. Calls made after close() starts fail with DATABASE_CLOSED.
     * @returns {Promise<void>}
     */
    async close() {
        if (!this.#initialized || this.#closed) return;
        this.#closed = true;
        await this.#transactions.close();
        await this.#lock.release();
        this.#lock = null;
        this.#initialized = false;
    }

    async #load() {
        const configs = await this.#readConfigs();

        const relations = new RelationManager(
            new Map([...configs].map(([name, { config }]) => [name, config]))
        );

        const collections = new Map();
        const warnings = [];
        for (const [name, { directory, config }] of configs) {
            const collection = new Collection(name, directory, config);
            warnings.push(...(await collection.loadRecords()));
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
            collection: (name) => this.#resolveCollection(name),
            relations,
            timeout: this.#transactionTimeout,
        });
        this.#warnings = warnings;
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
     * @param {(tx: import('./transaction.js').Transaction) => Promise<T>} body
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
        return this.#resolveCollection(name);
    }

    /**
     * Finds a collection without checking the database state. Used by transactions,
     * which must be able to finish their commit while close() waits for them.
     */
    #resolveCollection(name) {
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
        if (this.#closed) {
            throw new DatabaseError(
                'The database is closed.',
                503,
                'DATABASE_CLOSED'
            );
        }
        if (!this.#initialized) {
            throw new DatabaseError(
                'File database is not initialized.',
                503,
                'DATABASE_NOT_READY'
            );
        }
    }
}
