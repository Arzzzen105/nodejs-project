import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseError } from './errors.js';
import { Collection } from './collection.js';
import { Journal } from './journal.js';
import { assertLogger, defaultLogger } from './logger-contract.js';
import { ProcessLock } from './process-lock.js';
import { RelationManager } from './relation-manager.js';
import { TransactionManager, assertTimeout } from './transaction-manager.js';
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

const WARNING_TITLES = {
    INVALID_RECORD: 'Record does not match the schema',
    DUPLICATE_VALUE: 'Record shares a unique value',
};

/**
 * Re-checks records changed by a replayed journal: their warnings from loading
 * are outdated, and records written by the journal were not checked at all.
 * @param {LoadWarning[]} warnings
 * @param {import('./journal.js').JournalChange[]} changes
 * @param {Map<string, Collection>} collections
 * @returns {LoadWarning[]}
 */
function refreshWarnings(warnings, changes, collections) {
    const key = (collection, id) => `${collection}/${id}`;
    const changed = new Set(changes.map((c) => key(c.collection, c.id)));
    const refreshed = warnings.filter(
        (w) => !changed.has(key(w.collection, w.id))
    );
    for (const { collection, id, record } of changes) {
        if (record === null) continue;
        const problem = collections.get(collection).schemaProblem(record);
        if (problem) {
            refreshed.push({
                code: 'INVALID_RECORD',
                collection,
                id,
                message: problem,
            });
        }
    }
    return refreshed;
}

/**
 * @typedef {import('./transaction.js').DeleteReport} DeleteReport
 * @typedef {import('./collection.js').LoadWarning} LoadWarning
 */

/**
 * FileDatabase facade coordinating multiple collections, schemas, relations and persistence.
 */
export class FileDatabase {
    #root;
    #logger;
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
     * @param {import('./logger-contract.js').Logger} [options.logger] pino-compatible logger;
     *   by default debug/info are silent and warn/error go to the console
     * @param {number} [options.transactionTimeout=10000] Max duration of a transaction
     *   body in milliseconds; 0 disables the limit
     */
    constructor(
        root = process.env.DATABASE_DIR ??
            path.resolve(process.cwd(), 'database'),
        { logger = defaultLogger, transactionTimeout = 10000 } = {}
    ) {
        // checked here as well, so a bad value fails at construction, not at init
        assertTimeout(transactionTimeout);
        assertLogger(logger);
        this.#root = path.resolve(root);
        this.#logger = logger;
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
        const startedAt = performance.now();
        await fs.mkdir(this.#root, { recursive: true });
        const lock = new ProcessLock(this.#root, this.#logger);
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

        for (const { message, ...fields } of this.#warnings) {
            this.#logger.warn(
                fields,
                `${WARNING_TITLES[fields.code]}: ${message}`
            );
        }
        let records = 0;
        for (const collection of this.#collections.values()) {
            records += collection.ids().size;
        }
        this.#logger.info(
            {
                root: this.#root,
                collections: this.#collections.size,
                records,
                warnings: this.#warnings.length,
                ms: Math.round(performance.now() - startedAt),
            },
            'Database opened'
        );
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
        this.#logger.info({ root: this.#root }, 'Database closed');
    }

    async #load() {
        const configs = await this.#readConfigs();

        const relations = new RelationManager(
            new Map([...configs].map(([name, { config }]) => [name, config]))
        );

        const collections = new Map();
        let warnings = [];
        for (const [name, { directory, config }] of configs) {
            const collection = new Collection(name, directory, config);
            warnings.push(...(await collection.loadRecords()));
            collections.set(name, collection);
        }

        const journal = new Journal(this.#root);
        const pending = await journal.recover();
        if (pending) {
            this.#logger.warn(
                { changes: pending.length },
                'Finishing a commit interrupted by a crash, found in the journal'
            );
            await applyJournal(pending, collections);
            warnings = refreshWarnings(warnings, pending, collections);
        }

        relations.checkIntegrity((name) => collections.get(name));
        if (pending) await journal.clear();
        for (const collection of collections.values()) {
            warnings.push(...collection.duplicateWarnings());
        }

        this.#collections = collections;
        this.#transactions = new TransactionManager({
            journal,
            collection: (name) => this.#resolveCollection(name),
            relations,
            timeout: this.#transactionTimeout,
            logger: this.#logger,
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
     * @param {object} [options]
     * @param {number} [options.timeout] Limit for this transaction in milliseconds,
     *   overriding `transactionTimeout` of the constructor; 0 disables it
     * @returns {Promise<T>}
     */
    async transaction(body, options) {
        this.#assertInitialized();
        this.#assertOutsideTransaction('transaction');
        return this.#transactions.run(body, options);
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
