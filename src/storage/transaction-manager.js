import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseError } from './errors.js';
import { ReadWriteLock } from './lock-manager.js';
import { Transaction, TransactionRollback } from './transaction.js';

/**
 * @typedef {import('./collection.js').Collection} Collection
 * @typedef {import('./journal.js').Journal} Journal
 * @typedef {import('./relation-manager.js').RelationManager} RelationManager
 */

/**
 * Runs transactions one at a time with full isolation and commits them atomically.
 *
 * - Writers are serialized: a transaction holds the writer slot from its first
 *   statement until its commit, so nothing else changes the database meanwhile.
 * - Readers outside transactions run concurrently and see committed data only;
 *   they are blocked just for the short moment a commit is applied.
 * - A commit is made durable by the journal before record files are touched.
 */
export class TransactionManager {
    #journal;
    #collection;
    #relations;
    #lock = new ReadWriteLock();
    #writerQueue = Promise.resolve();
    #context = new AsyncLocalStorage();
    #failure = null;
    #closed = false;
    #timeout;

    /**
     * @param {object} options
     * @param {Journal} options.journal
     * @param {(name: string) => Collection} options.collection Returns a collection
     *   by name, throws for unknown names
     * @param {RelationManager} options.relations
     * @param {number} [options.timeout=10000] Max duration of a transaction body
     *   in milliseconds; 0 disables the limit
     */
    constructor({ journal, collection, relations, timeout = 10000 }) {
        assertTimeout(timeout);
        this.#journal = journal;
        this.#collection = collection;
        this.#relations = relations;
        this.#timeout = timeout;
    }

    /**
     * The transaction running in the current async call chain, or null.
     * @returns {Transaction|null}
     */
    get current() {
        const transaction = this.#context.getStore();
        return transaction?.active ? transaction : null;
    }

    /**
     * Runs `body` in a new transaction.
     * Resolves with the body's result after a successful commit, or with the value
     * passed to `tx.rollback(value)`. If the body throws, nothing is written and
     * the error is rethrown.
     * @template T
     * @param {(tx: Transaction) => Promise<T>} body
     * @param {object} [options]
     * @param {number} [options.timeout] Limit for this transaction in milliseconds,
     *   overriding the default; 0 disables it
     * @returns {Promise<T>}
     */
    async run(body, options) {
        if (typeof body !== 'function') {
            throw new TypeError('transaction() expects a function.');
        }
        const timeout = transactionTimeout(options, this.#timeout);
        return this.#exclusive(async () => {
            const transaction = new Transaction({
                collection: this.#collection,
                relations: this.#relations,
            });
            try {
                let result;
                try {
                    result = await this.#withTimeout(
                        transaction,
                        timeout,
                        async () => {
                            const value = await this.#context.run(
                                transaction,
                                () => body(transaction)
                            );
                            await transaction.idle();
                            return value;
                        }
                    );
                } catch (error) {
                    if (
                        error instanceof TransactionRollback &&
                        error.transaction === transaction
                    ) {
                        return transaction.rollbackRequest.value;
                    }
                    throw error;
                }
                // the body may have caught the rollback signal itself
                if (transaction.rollbackRequest) {
                    return transaction.rollbackRequest.value;
                }
                // seal before reading changes: an operation arriving later (e.g. from
                // a timer) must fail loudly instead of landing in a discarded buffer
                transaction.close();
                await this.#commit(transaction);
                return result;
            } finally {
                // let operations the body did not await finish before closing
                await transaction.idle();
                transaction.close();
            }
        });
    }

    /**
     * Stops accepting work and waits for the running transaction and reads.
     * Later calls fail with DATABASE_CLOSED.
     * @returns {Promise<void>}
     */
    async close() {
        if (this.#closed) return;
        this.#closed = true;
        await this.#writerQueue;
        // a write lock is granted only after every active reader has finished
        await this.#lock.withWrite(async () => {});
    }

    /**
     * Runs a read of committed data. Waits only while a commit is being applied.
     * @template T
     * @param {() => Promise<T>} operation
     * @returns {Promise<T>}
     */
    async read(operation) {
        this.#assertOpen();
        this.#assertHealthy();
        return this.#lock.withRead(operation);
    }

    /**
     * Runs an operation in the writer slot, one at a time.
     * @template T
     * @param {() => Promise<T>} operation
     * @returns {Promise<T>}
     */
    async #exclusive(operation) {
        this.#assertOpen();
        this.#assertHealthy();
        // work accepted before close() still runs; only a failed commit stops it
        const result = this.#writerQueue.then(() => {
            this.#assertHealthy();
            return operation();
        });
        this.#writerQueue = result.catch(() => {});
        return result;
    }

    /**
     * Commits buffered changes.
     *
     * Every commit goes through the journal, so a journal left on disk is always
     * the latest commit and replaying it on start can never overwrite newer data.
     * Any disk error after the commit point leaves memory and disk possibly out of
     * sync, so the database refuses further work until a restart recovers it.
     */
    async #commit(transaction) {
        const changes = transaction.changes();
        if (changes.length === 0) return;

        try {
            await this.#journal.write(changes);
        } catch (error) {
            // The journal may or may not have reached the disk.
            await this.#discardJournal(error);
            throw error;
        }

        try {
            await this.#lock.withWrite(async () => {
                for (const { collection, id, record } of changes) {
                    const target = this.#collection(collection);
                    if (record === null) await target.applyDelete(id);
                    else await target.applyPut(record);
                }
            });
        } catch (error) {
            this.#failure = error;
            throw new DatabaseError(
                `Failed to apply a committed transaction: ${error.message}. Restart the server to recover it from the journal.`,
                503,
                'DATABASE_NEEDS_RECOVERY'
            );
        }

        try {
            await this.#journal.clear();
        } catch (error) {
            // The commit is fully applied, so the caller gets its result. But a new
            // commit must not run while this journal is on disk: the next start
            // replays it, and it has to be the latest commit for that to be safe.
            this.#failure = error;
        }
    }

    /**
     * Removes a journal whose write failed. If even that fails, the transaction
     * may still be replayed on the next start, so the database stops accepting work.
     */
    async #discardJournal(writeError) {
        try {
            await this.#journal.clear();
        } catch {
            this.#failure = writeError;
            throw new DatabaseError(
                `Failed to write the transaction journal: ${writeError.message}. The transaction may be applied on the next start. Restart the server to recover.`,
                503,
                'DATABASE_NEEDS_RECOVERY'
            );
        }
    }

    /**
     * Runs the transaction body with the configured time limit. On timeout the
     * transaction is sealed, so whatever the body does later fails, and the
     * writer slot is freed for the next transaction.
     */
    async #withTimeout(transaction, timeout, operation) {
        if (timeout === 0) return operation();

        let timer;
        const expired = new Promise((_, reject) => {
            timer = setTimeout(() => {
                transaction.close();
                reject(
                    new DatabaseError(
                        `The transaction did not finish within ${timeout} ms and was rolled back.`,
                        503,
                        'TRANSACTION_TIMEOUT'
                    )
                );
            }, timeout);
            timer.unref?.();
        });
        const running = operation();
        // the body keeps running after a timeout; its later failure is expected
        running.catch(() => {});
        try {
            return await Promise.race([running, expired]);
        } finally {
            clearTimeout(timer);
        }
    }

    #assertOpen() {
        if (this.#closed) {
            throw new DatabaseError(
                'The database is closed.',
                503,
                'DATABASE_CLOSED'
            );
        }
    }

    #assertHealthy() {
        if (this.#failure) {
            throw new DatabaseError(
                'The database needs recovery. Restart the server to finish the last commit.',
                503,
                'DATABASE_NEEDS_RECOVERY'
            );
        }
    }
}

function assertTimeout(timeout) {
    if (!Number.isFinite(timeout) || timeout < 0) {
        throw new TypeError(
            'Transaction timeout must be a non-negative number of milliseconds.'
        );
    }
}

/**
 * Reads per-transaction options; unknown keys are rejected so a typo such as
 * `{ timout: 60000 }` does not silently fall back to the default.
 * @param {{ timeout?: number }|undefined|null} options
 * @param {number} fallback Default timeout of the manager
 * @returns {number}
 */
function transactionTimeout(options, fallback) {
    if (options === undefined || options === null) return fallback;
    if (typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('Transaction options must be an object.');
    }
    const unknown = Object.keys(options).find((key) => key !== 'timeout');
    if (unknown !== undefined) {
        throw new TypeError(`Unknown transaction option "${unknown}".`);
    }
    if (options.timeout === undefined) return fallback;
    assertTimeout(options.timeout);
    return options.timeout;
}
