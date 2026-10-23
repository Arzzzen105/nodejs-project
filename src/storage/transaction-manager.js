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

    /**
     * @param {object} options
     * @param {Journal} options.journal
     * @param {(name: string) => Collection} options.collection Returns a collection
     *   by name, throws for unknown names
     * @param {RelationManager} options.relations
     */
    constructor({ journal, collection, relations }) {
        this.#journal = journal;
        this.#collection = collection;
        this.#relations = relations;
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
     * @returns {Promise<T>}
     */
    async run(body) {
        if (typeof body !== 'function') {
            throw new TypeError('transaction() expects a function.');
        }
        return this.#exclusive(async () => {
            const transaction = new Transaction({
                collection: this.#collection,
                relations: this.#relations,
            });
            try {
                let result;
                try {
                    result = await this.#context.run(transaction, () =>
                        body(transaction)
                    );
                    await transaction.idle();
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
     * Runs a read of committed data. Waits only while a commit is being applied.
     * @template T
     * @param {() => Promise<T>} operation
     * @returns {Promise<T>}
     */
    async read(operation) {
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
        this.#assertHealthy();
        const result = this.#writerQueue.then(() => {
            this.#assertHealthy();
            return operation();
        });
        this.#writerQueue = result.catch(() => {});
        return result;
    }

    async #commit(transaction) {
        const changes = transaction.changes();
        if (changes.length === 0) return;

        // A single record write is atomic by itself; the journal is only needed
        // to make several record writes all-or-nothing.
        const journaled = changes.length > 1;
        if (journaled) await this.#journal.write(changes);
        try {
            await this.#lock.withWrite(async () => {
                for (const { collection, id, record } of changes) {
                    const target = this.#collection(collection);
                    if (record === null) await target.applyDelete(id);
                    else await target.applyPut(record);
                }
            });
        } catch (error) {
            if (!journaled) throw error;
            // Committed but only partly applied: the in-memory state is unreliable.
            // The journal stays on disk and is replayed on the next start.
            this.#failure = error;
            throw new DatabaseError(
                `Failed to apply a committed transaction: ${error.message}. Restart the server to recover it from the journal.`,
                503,
                'DATABASE_NEEDS_RECOVERY'
            );
        }
        // Already applied: a leftover journal is replayed harmlessly on the next start.
        if (journaled) await this.#journal.clear().catch(() => {});
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
