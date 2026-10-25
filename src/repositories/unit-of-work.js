import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Unit of work over a FileDatabase: lets repositories and services run several
 * operations in one transaction without passing the transaction around.
 *
 * `run(body)` opens a transaction, or joins the one already running in the
 * current async call chain (like Spring's REQUIRED propagation). Repositories
 * ask `executor()` for what to call: the current transaction inside `run`, the
 * database outside of it. A repository method and the service method calling
 * it may therefore both use `run`: the outer one owns the transaction, the
 * inner one joins it.
 *
 * One rule for errors: any error thrown in a unit rolls back the whole
 * transaction, and the first error is what the outermost `run` rejects with.
 * Catching the error of a nested `run` does not save the transaction: its
 * changes so far are already buffered, so the transaction is doomed. From then
 * on every `executor()` call and nested `run` throws that first error at once,
 * and the outermost `run` rejects with it even if the body returns normally.
 * Check a condition before calling instead of catching a failed nested unit.
 *
 * `options` of a joined `run` (e.g. `timeout`) are ignored: the transaction is
 * configured by the `run` that opened it.
 *
 * @example
 * const uow = new UnitOfWork(db);
 * await uow.run(async () => {
 *     const parent = await uow.executor().get('parents', parentId);
 *     await uow.executor().update('parents', parentId, { childIds: [...parent.childIds, kidId] });
 * });
 */
export class UnitOfWork {
    #database;
    /** @type {AsyncLocalStorage<{ transaction: object, failure: Error|null }>} */
    #current = new AsyncLocalStorage();

    /**
     * @param {import('../storage/file-database.js').FileDatabase} database
     */
    constructor(database) {
        this.#database = database;
    }

    /**
     * What repositories call `get`/`list`/`create`/`update`/`delete` on.
     * @returns {object} The transaction of the current unit, or the database
     * @throws {Error} The first error of the unit, once a nested unit has failed
     */
    executor() {
        const unit = this.#current.getStore();
        if (!unit) return this.#database;
        if (unit.failure) throw unit.failure;
        return unit.transaction;
    }

    /**
     * @returns {boolean} Whether the caller runs inside a unit of work
     */
    get active() {
        return this.#current.getStore() !== undefined;
    }

    /**
     * Runs `body` in a transaction: the current one if there is one, a new one
     * otherwise. Resolves with what `body` returns once the outermost unit has
     * committed; rejects with the first error thrown in the transaction.
     * @template T
     * @param {() => Promise<T>} body
     * @param {{ timeout?: number }} [options] For a new transaction only
     * @returns {Promise<T>}
     */
    async run(body, options) {
        if (typeof body !== 'function') {
            throw new TypeError('run() expects a function.');
        }
        const unit = this.#current.getStore();
        if (unit) return this.#join(unit, body);

        return this.#database.transaction(async (transaction) => {
            const opened = { transaction, failure: null };
            let result;
            try {
                result = await this.#current.run(opened, body);
            } catch (error) {
                throw opened.failure ?? error;
            }
            // a nested failure the body caught still rolls back (by throwing)
            if (opened.failure) throw opened.failure;
            return result;
        }, options);
    }

    /**
     * @template T
     * @param {{ failure: Error|null }} unit
     * @param {() => Promise<T>} body
     * @returns {Promise<T>}
     */
    async #join(unit, body) {
        if (unit.failure) throw unit.failure;
        try {
            return await body();
        } catch (error) {
            unit.failure ??= error;
            throw error;
        }
    }
}
