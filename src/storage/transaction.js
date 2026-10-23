import { DatabaseError } from './errors.js';
import { assertWritableBody } from './collection.js';
import { valueKey } from './index-manager.js';
import { executeGet, executeList, notFound } from './query-context.js';
import { matchesRange } from './range.js';
import { validateId } from './validator.js';

/**
 * @typedef {import('./collection.js').Collection} Collection
 * @typedef {import('./relation-manager.js').RelationManager} RelationManager
 * @typedef {import('./journal.js').JournalChange} JournalChange
 */

/**
 * @typedef {object} DeleteReport
 * @property {Array<{ collection: string, id: string }>} deleted Deleted records
 * @property {Array<{ collection: string, id: string, fields: string[] }>} updated
 *   Records whose references were nulled or removed by `onDelete` rules
 */

/**
 * Thrown by `tx.rollback()` to stop the transaction body.
 * TransactionManager catches it and discards the transaction.
 */
export class TransactionRollback extends Error {
    /**
     * @param {Transaction} transaction
     */
    constructor(transaction) {
        super('Transaction rolled back.');
        this.name = 'TransactionRollback';
        this.transaction = transaction;
    }
}

/**
 * Read view of one collection inside a transaction: buffered changes on top of
 * the committed collection. It implements the same interface as Collection for
 * queries (QueryContext) and for relations (RelationManager), so predicates and
 * reference rules work unchanged on uncommitted data.
 */
export class CollectionView {
    #base;
    #changes;

    /**
     * @param {Collection} base Committed collection
     * @param {Map<string, object|null>} changes Buffered final states by id (null = deleted)
     */
    constructor(base, changes) {
        this.#base = base;
        this.#changes = changes;
    }

    get config() {
        return this.#base.config;
    }

    /**
     * Ids visible in the transaction.
     * @returns {Set<string>}
     */
    ids() {
        const ids = this.#base.ids();
        for (const [id, record] of this.#changes) {
            if (record === null) ids.delete(id);
            else ids.add(id);
        }
        return ids;
    }

    has(id) {
        if (this.#changes.has(id)) return this.#changes.get(id) !== null;
        return this.#base.has(id);
    }

    /**
     * Reads the record as seen by the transaction.
     * @param {string} id
     * @returns {Promise<object>}
     */
    async readRecord(id) {
        if (this.#changes.has(id)) {
            const record = this.#changes.get(id);
            if (record === null) throw notFound();
            return structuredClone(record);
        }
        return this.#base.readRecord(id);
    }

    hasIndex(field) {
        return this.#base.hasIndex(field);
    }

    lookupIndex(field, value) {
        const key = valueKey(value);
        return this.#overlay(this.#base.lookupIndex(field, value), (record) =>
            Object.hasOwn(record, field)
                ? valueKey(record[field]) === key
                : false
        );
    }

    lookupInIndex(field, values) {
        const keys = new Set(values.map(valueKey));
        return this.#overlay(
            this.#base.lookupInIndex(field, values),
            (record) =>
                Object.hasOwn(record, field)
                    ? keys.has(valueKey(record[field]))
                    : false
        );
    }

    lookupRangeIndex(field, bounds) {
        return this.#overlay(
            this.#base.lookupRangeIndex(field, bounds),
            (record) =>
                Object.hasOwn(record, field) &&
                matchesRange(record[field], bounds)
        );
    }

    /**
     * Records referencing the given id through a reference column.
     * @param {string} field
     * @param {string} id
     * @returns {Set<string>}
     */
    findReferrers(field, id) {
        return this.#overlay(this.#base.findReferrers(field, id), (record) =>
            Array.isArray(record[field])
                ? record[field].includes(id)
                : record[field] === id
        );
    }

    /**
     * Combines an index result of the committed collection with buffered records:
     * ids changed in the transaction are dropped from the index result and
     * re-checked against their buffered version instead.
     * @param {Set<string>|null} committed
     * @param {(record: object) => boolean} matches
     * @returns {Set<string>|null}
     */
    #overlay(committed, matches) {
        if (committed === null) return null;
        const result = new Set(committed);
        for (const [id, record] of this.#changes) {
            result.delete(id);
            if (record !== null && matches(record)) result.add(id);
        }
        return result;
    }
}

/**
 * A unit of work over the database. Changes are kept in memory as final record
 * states and become visible to other readers only when the TransactionManager
 * commits them. Every read and write inside the transaction sees its own changes.
 *
 * Operations of one transaction run one after another, even if the caller
 * starts them concurrently, so they never interleave at an `await`.
 */
export class Transaction {
    #collection;
    #relations;
    #changes = new Map();
    #views = new Map();
    #queue = Promise.resolve();
    #active = true;
    #rollback = null;
    #resolve = (name) => this.#view(name);

    /**
     * @param {object} options
     * @param {(name: string) => Collection} options.collection Returns a committed
     *   collection by name, throws for unknown names
     * @param {RelationManager} options.relations
     */
    constructor({ collection, relations }) {
        this.#collection = collection;
        this.#relations = relations;
    }

    /**
     * @param {string} name
     * @param {string} id
     * @returns {Promise<object>}
     */
    async get(name, id) {
        return this.#serialize(() => executeGet(this.#view(name), id));
    }

    /**
     * @param {string} name
     * @param {object} [options] Same options as Collection.list
     */
    async list(name, options) {
        return this.#serialize(() => executeList(this.#view(name), options));
    }

    /**
     * @param {string} name
     * @param {object} input
     * @returns {Promise<object>} Created record
     */
    async create(name, input) {
        return this.#serialize(async () => {
            const record = this.#collection(name).prepareCreate(input);
            this.#relations.validateReferences(name, record, this.#resolve);
            this.#put(name, record);
            return structuredClone(record);
        });
    }

    /**
     * @param {string} name
     * @param {string} id
     * @param {object} changes
     * @param {object} [options]
     * @param {boolean} [options.replace=false]
     * @returns {Promise<object>} Updated record
     */
    async update(name, id, changes, options) {
        const { replace = false } = options ?? {};
        return this.#serialize(async () => {
            validateId(id);
            assertWritableBody(changes, 'The "id" field cannot be changed.');
            const view = this.#view(name);
            if (!view.has(id)) throw notFound();

            const previous = await view.readRecord(id);
            const candidate = this.#collection(name).prepareUpdate(
                previous,
                changes,
                { replace }
            );
            this.#relations.validateReferences(name, candidate, this.#resolve);
            this.#put(name, candidate);
            return structuredClone(candidate);
        });
    }

    /**
     * Deletes a record and applies `onDelete` rules of references pointing to it.
     * @param {string} name
     * @param {string} id
     * @returns {Promise<DeleteReport>}
     */
    async delete(name, id) {
        return this.#serialize(async () => {
            validateId(id);
            const view = this.#view(name);
            if (!view.has(id)) throw notFound();

            const plan = this.#relations.planDelete(name, id, this.#resolve);
            const updated = [];
            for (const change of plan) {
                const referrer = this.#view(change.collection);
                const previous = await referrer.readRecord(change.id);
                const patch = {};
                for (const field of change.setNull) patch[field] = null;
                for (const field of change.remove) {
                    patch[field] = previous[field].filter(
                        (value) => value !== id
                    );
                }
                this.#put(
                    change.collection,
                    this.#collection(change.collection).prepareUpdate(
                        previous,
                        patch
                    )
                );
                updated.push({
                    collection: change.collection,
                    id: change.id,
                    fields: [...change.setNull, ...change.remove],
                });
            }

            this.#remove(name, id);
            return { deleted: [{ collection: name, id }], updated };
        });
    }

    /**
     * Stops the transaction body and discards all its changes.
     * The transaction resolves with `value` instead of the body's result.
     * @param {*} [value]
     * @returns {never}
     */
    rollback(value) {
        this.#assertActive();
        this.#rollback = { value };
        throw new TransactionRollback(this);
    }

    /**
     * Rollback request, or null. Set even if the body swallowed the rollback signal.
     * @returns {{ value: * }|null}
     */
    get rollbackRequest() {
        return this.#rollback;
    }

    /** @returns {boolean} */
    get active() {
        return this.#active;
    }

    /**
     * Resolves once all started operations have finished.
     * @returns {Promise<void>}
     */
    async idle() {
        let queue;
        do {
            queue = this.#queue;
            await queue;
        } while (queue !== this.#queue);
    }

    /**
     * Makes the transaction unusable; later operations fail with TRANSACTION_CLOSED.
     */
    close() {
        this.#active = false;
    }

    /**
     * Buffered changes as final record states: puts first, then deletes.
     * @returns {JournalChange[]}
     */
    changes() {
        const puts = [];
        const deletes = [];
        for (const [collection, records] of this.#changes) {
            for (const [id, record] of records) {
                (record === null ? deletes : puts).push({
                    collection,
                    id,
                    record: record === null ? null : structuredClone(record),
                });
            }
        }
        return [...puts, ...deletes];
    }

    /**
     * Runs operations of this transaction one at a time.
     * A failed operation does not block the following ones.
     */
    #serialize(operation) {
        this.#assertActive();
        const result = this.#queue.then(() => {
            this.#assertActive();
            return operation();
        });
        this.#queue = result.catch(() => {});
        return result;
    }

    #assertActive() {
        if (!this.#active) {
            throw new DatabaseError(
                'The transaction is already finished.',
                500,
                'TRANSACTION_CLOSED'
            );
        }
    }

    #view(name) {
        const collection = this.#collection(name);
        if (!this.#views.has(name)) {
            this.#views.set(
                name,
                new CollectionView(collection, this.#changesOf(name))
            );
        }
        return this.#views.get(name);
    }

    #changesOf(name) {
        if (!this.#changes.has(name)) this.#changes.set(name, new Map());
        return this.#changes.get(name);
    }

    #put(name, record) {
        this.#changesOf(name).set(record.id, structuredClone(record));
    }

    #remove(name, id) {
        const changes = this.#changesOf(name);
        // a record created and deleted in the same transaction leaves no trace
        if (this.#collection(name).has(id)) changes.set(id, null);
        else changes.delete(id);
    }
}
