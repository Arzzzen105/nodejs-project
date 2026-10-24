import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseError, DatabaseErrors } from './errors.js';
import { ReadWriteLock } from './lock-manager.js';
import { defaultLogger } from './logger-contract.js';
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
    // Memory and disk may disagree: nothing may run until a restart recovers.
    #failure = null;
    // Memory and disk agree, but a journal is left on disk that must stay the
    // latest commit: reads still work, new commits are refused until a restart.
    #writesBlocked = null;
    #closed = false;
    #timeout;
    #logger;

    /**
     * @param {object} options
     * @param {Journal} options.journal
     * @param {(name: string) => Collection} options.collection Returns a collection
     *   by name, throws for unknown names
     * @param {RelationManager} options.relations
     * @param {number} [options.timeout=10000] Max duration of a transaction body
     *   in milliseconds; 0 disables the limit
     */
    constructor({
        journal,
        collection,
        relations,
        timeout = 10000,
        logger = defaultLogger,
    }) {
        assertTimeout(timeout);
        this.#journal = journal;
        this.#collection = collection;
        this.#relations = relations;
        this.#timeout = timeout;
        this.#logger = logger;
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
            const startedAt = performance.now();
            const elapsed = () => Math.round(performance.now() - startedAt);
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
                        this.#logger.debug(
                            { ms: elapsed() },
                            'Transaction rolled back'
                        );
                        return transaction.rollbackRequest.value;
                    }
                    // validation errors and the like are expected, hence debug
                    this.#logger.debug(
                        { ms: elapsed(), code: error.code },
                        'Transaction failed and was rolled back'
                    );
                    throw error;
                }
                // the body may have caught the rollback signal itself
                if (transaction.rollbackRequest) {
                    this.#logger.debug(
                        { ms: elapsed() },
                        'Transaction rolled back'
                    );
                    return transaction.rollbackRequest.value;
                }
                // seal before reading changes: an operation arriving later (e.g. from
                // a timer) must fail loudly instead of landing in a discarded buffer
                transaction.close();
                const changes = await this.#commit(transaction);
                this.#logger.debug(
                    { ...summarize(changes), ms: elapsed() },
                    'Transaction committed'
                );
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
        this.#assertReadable();
        return this.#lock.withRead(() => {
            // checked again: the commit this read waited for may have failed
            // half-applied while the read was queued
            this.#assertReadable();
            return operation();
        });
    }

    /**
     * Runs an operation in the writer slot, one at a time.
     * @template T
     * @param {() => Promise<T>} operation
     * @returns {Promise<T>}
     */
    async #exclusive(operation) {
        this.#assertOpen();
        this.#assertWritable();
        // work accepted before close() still runs; only a failed commit stops it
        const result = this.#writerQueue.then(() => {
            this.#assertWritable();
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
     * @param {Transaction} transaction
     * @returns {Promise<import('./journal.js').JournalChange[]>} The committed changes
     */
    async #commit(transaction) {
        const changes = transaction.changes();
        if (changes.length === 0) return changes;

        try {
            await this.#journal.write(changes);
        } catch (error) {
            // The journal may or may not have reached the disk.
            await this.#discardJournal(error);
            this.#logger.warn(
                { err: error },
                'Failed to write the transaction journal; the transaction was discarded'
            );
            throw error;
        }

        try {
            await this.#lock.withWrite(async () => {
                try {
                    for (const { collection, id, record } of changes) {
                        const target = this.#collection(collection);
                        if (record === null) await target.applyDelete(id);
                        else await target.applyPut(record);
                    }
                } catch (error) {
                    // set while the write lock is still held: releasing it lets
                    // queued reads in, and they must already see the failure
                    this.#failure = error;
                    throw error;
                }
            });
        } catch (error) {
            this.#logger.error(
                { err: error, changes: changes.length },
                'Failed to apply a committed transaction; restart the server to recover it from the journal'
            );
            throw new DatabaseError(
                DatabaseErrors.DATABASE_NEEDS_RECOVERY,
                `Failed to apply a committed transaction: ${error.message}. Restart the server to recover it from the journal.`
            );
        }

        try {
            await this.#journal.clear();
        } catch (error) {
            // The commit is fully applied, so the caller gets its result. But a new
            // commit must not run while this journal is on disk: the next start
            // replays it, and it has to be the latest commit for that to be safe.
            this.#writesBlocked = error;
            this.#logger.error(
                { err: error },
                'Cannot remove the transaction journal; writes are disabled until restart'
            );
        }
        return changes;
    }

    /**
     * Removes a journal whose write failed. If even that fails, the transaction
     * may still be replayed on the next start, so no new commit may follow it.
     * Nothing was applied, so reads of the current state stay correct.
     * @param {Error} writeError Why writing the journal failed
     * @returns {Promise<void>}
     */
    async #discardJournal(writeError) {
        try {
            await this.#journal.clear();
        } catch (error) {
            this.#writesBlocked = writeError;
            this.#logger.error(
                { err: writeError, cleanupError: error },
                'Failed to write the transaction journal and to remove it; writes are disabled until restart'
            );
            throw new DatabaseError(
                DatabaseErrors.DATABASE_NEEDS_RECOVERY,
                `Failed to write the transaction journal: ${writeError.message}. The transaction may be applied on the next start. Restart the server to recover.`
            );
        }
    }

    /**
     * Runs the transaction body with the configured time limit. On timeout the
     * transaction is sealed, so whatever the body does later fails, and the
     * writer slot is freed for the next transaction.
     * @template T
     * @param {Transaction} transaction
     * @param {number} timeout Milliseconds; 0 means no limit
     * @param {() => Promise<T>} operation The body together with waiting for its operations
     * @returns {Promise<T>}
     */
    async #withTimeout(transaction, timeout, operation) {
        if (timeout === 0) return operation();

        let timer;
        const expired = new Promise((_, reject) => {
            timer = setTimeout(() => {
                transaction.close();
                this.#logger.warn(
                    { timeout },
                    'Transaction timed out and was rolled back'
                );
                reject(
                    new DatabaseError(
                        DatabaseErrors.TRANSACTION_TIMEOUT,
                        `The transaction did not finish within ${timeout} ms and was rolled back.`
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

    /**
     * @throws {DatabaseError} DATABASE_CLOSED after close()
     */
    #assertOpen() {
        if (this.#closed) {
            throw new DatabaseError(
                DatabaseErrors.DATABASE_CLOSED,
                'The database is closed.'
            );
        }
    }

    /**
     * @throws {DatabaseError} DATABASE_NEEDS_RECOVERY if memory and disk may disagree
     */
    #assertReadable() {
        if (this.#failure) {
            throw new DatabaseError(
                DatabaseErrors.DATABASE_NEEDS_RECOVERY,
                'The database needs recovery. Restart the server to finish the last commit.'
            );
        }
    }

    /**
     * @throws {DatabaseError} DATABASE_NEEDS_RECOVERY if writes are disabled until restart
     */
    #assertWritable() {
        this.#assertReadable();
        if (this.#writesBlocked) {
            throw new DatabaseError(
                DatabaseErrors.DATABASE_NEEDS_RECOVERY,
                'Writes are disabled until restart: the transaction journal could not be removed. Reads still work.'
            );
        }
    }
}

/**
 * @param {*} timeout
 * @throws {TypeError} unless timeout is a non-negative number of milliseconds
 */
export function assertTimeout(timeout) {
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

/**
 * Loggable summary of a commit: how many records changed in which collections.
 * @param {import('./journal.js').JournalChange[]} changes
 */
function summarize(changes) {
    const collections = {};
    for (const { collection } of changes) {
        collections[collection] = (collections[collection] ?? 0) + 1;
    }
    return { changes: changes.length, collections };
}
