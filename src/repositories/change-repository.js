/**
 * @typedef {import('./unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../storage/journal.js').CommitEntry} CommitEntry
 */

/**
 * The history of changes (FR-15): what the database recorded on every commit.
 * It is no collection, so it does not extend BaseRepository. The history is
 * only read, and outside a transaction: a transaction cannot read it.
 */
export class ChangeRepository {
    #uow;

    /**
     * @param {UnitOfWork} uow
     */
    constructor(uow) {
        this.#uow = uow;
    }

    /**
     * Committed transactions, oldest first.
     * @param {object} [days] Only the days to read, by UTC
     * @param {string} [days.since] `YYYY-MM-DD`
     * @param {string} [days.until] `YYYY-MM-DD`
     * @returns {Promise<CommitEntry[]>}
     */
    async findAll(days) {
        return this.#uow.executor().changes(days);
    }

    /**
     * @returns {string[]} Names of the collections whose changes are recorded
     */
    collections() {
        return this.#uow.executor().collections();
    }
}
