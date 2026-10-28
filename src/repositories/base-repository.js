/**
 * @typedef {import('./unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../storage/predicate.js').Predicate} Predicate
 */

/**
 * CRUD over one collection, for repositories to extend. Every call goes
 * through the unit of work, so it joins the transaction of the caller when
 * there is one. Records are returned as stored: references stay ids, related
 * records are loaded by named methods of the subclass.
 *
 * Naming: `find*` may find nothing (null, or an empty array), `get*` always
 * returns a record or throws 404 NOT_FOUND. Errors of the database (404, 409
 * UNIQUE_VIOLATION, 422 VALIDATION_ERROR…) pass through unchanged.
 *
 * @template T Shape of a record of the collection
 * @example
 * export class KidRepository extends BaseRepository {
 *     constructor(uow) {
 *         super(uow, 'kids');
 *     }
 *
 *     findByGroup(groupId) {
 *         return this.findAll({ where: { groupId } });
 *     }
 * }
 */
export class BaseRepository {
    #uow;
    #collection;

    /**
     * @param {UnitOfWork} uow
     * @param {string} collection Name of the collection, e.g. 'kids'
     */
    constructor(uow, collection) {
        this.#uow = uow;
        this.#collection = collection;
    }

    /**
     * For subclasses: what to call get/list/create/update/delete on — the
     * transaction of the current unit, or the database outside of one.
     * @protected
     * @returns {object}
     */
    get db() {
        return this.#uow.executor();
    }

    /**
     * For subclasses: the unit of work, to wrap methods with several
     * operations in `this.uow.run(...)`.
     * @protected
     * @returns {UnitOfWork}
     */
    get uow() {
        return this.#uow;
    }

    /**
     * @returns {string} Name of the collection this repository works with
     */
    get collection() {
        return this.#collection;
    }

    /**
     * A record by id, or null if there is none. Use it when a missing record is
     * a normal case to branch on; use {@link BaseRepository#getById} when it is
     * an error.
     * @param {string} id UUIDv7
     * @returns {Promise<T|null>}
     * @throws {Error} 400 INVALID_ID if `id` is not a UUIDv7: a malformed id is
     *   a bad request, not a missing record
     */
    async findById(id) {
        try {
            return await this.db.get(this.collection, id);
        } catch (error) {
            if (error.code === 'NOT_FOUND') return null;
            throw error;
        }
    }

    /**
     * A page of records for list endpoints: the client's ?where=&sort=&limit=&offset=
     * are passed through as is. Predicates are not accepted on purpose: queries
     * built in code belong to named methods of the subclass.
     * @param {object} [query]
     * @param {object} [query.where] Filter object, e.g. `{ age: { gte: 3 } }`
     * @param {string|string[]} [query.sort] e.g. 'lastName' or '-age'
     * @param {number} [query.limit=100] 1–500
     * @param {number} [query.offset=0]
     * @returns {Promise<{ items: T[], total: number, limit: number, offset: number }>}
     * @throws {Error} 400 INVALID_QUERY for an unknown field, operator or value
     */
    async findPage({ where, sort, limit, offset } = {}) {
        return this.db.list(this.collection, { where, sort, limit, offset });
    }

    /**
     * Every record matching a filter, for subclasses' named queries (findByGroup…).
     * Reads page by page, as `list` returns at most 500 records, in one transaction
     * so the pages agree.
     * @protected
     * @param {{ where?: object, predicate?: Predicate, sort?: string }} [filter]
     * @returns {Promise<T[]>}
     */
    async findAll(filter = {}) {
        return this.uow.run(async () => {
            const items = [];
            for (let offset = 0; ; offset += 500) {
                const page = await this.db.list(this.collection, {
                    ...filter,
                    limit: 500,
                    offset,
                });
                items.push(...page.items);
                if (page.items.length < 500 || items.length >= page.total)
                    return items;
            }
        });
    }

    /**
     * A record by id that must exist. Use it when a missing record ends the
     * request with 404; use {@link BaseRepository#findById} to branch on it.
     * @param {string} id UUIDv7
     * @returns {Promise<T>}
     * @throws {Error} 404 NOT_FOUND if there is no such record, 400 INVALID_ID
     *   if `id` is not a UUIDv7
     */
    async getById(id) {
        return this.db.get(this.collection, id);
    }

    /**
     * Creates a record. The database generates the id (and createdAt/updatedAt
     * when the collection has timestamps), fills in defaults and checks the
     * schema, references and unique columns.
     * @param {object} data Fields of the new record, without id
     * @returns {Promise<T>} The stored record, with its id
     * @throws {Error} 422 VALIDATION_ERROR or REFERENCE_NOT_FOUND, 409 UNIQUE_VIOLATION
     */
    async create(data) {
        return this.db.create(this.collection, data);
    }

    /**
     * Changes some fields of a record (PATCH): fields not in `changes` keep
     * their values. The result is checked against the schema as a whole.
     * @param {string} id UUIDv7
     * @param {object} changes Fields to change; id, createdAt and updatedAt cannot be set
     * @returns {Promise<T>} The record after the change
     * @throws {Error} 404 NOT_FOUND, 422 VALIDATION_ERROR or REFERENCE_NOT_FOUND,
     *   409 UNIQUE_VIOLATION
     */
    async update(id, changes) {
        return this.db.update(this.collection, id, changes, { replace: false });
    }

    /**
     * Replaces a record (PUT): fields not in `data` get their defaults, so
     * required ones must be given again. Keeps the id and createdAt.
     * @param {string} id UUIDv7
     * @param {object} data All fields of the record, without id
     * @returns {Promise<T>} The record after the change
     * @throws {Error} 404 NOT_FOUND, 422 VALIDATION_ERROR or REFERENCE_NOT_FOUND,
     *   409 UNIQUE_VIOLATION
     */
    async replace(id, data) {
        return this.db.update(this.collection, id, data, { replace: true });
    }

    /**
     * Deletes a record and applies the `onDelete` rules of references to it in
     * the same transaction: `setNull` clears them, `remove` drops the id from
     * arrays, `restrict` blocks the delete.
     * @param {string} id UUIDv7
     * @returns {Promise<{ deleted: Array<{ collection: string, id: string }>, updated: Array<{ collection: string, id: string, fields: string[] }> }>}
     *   What was deleted and which records lost a reference, e.g. kids whose
     *   groupId became null
     * @throws {Error} 404 NOT_FOUND, 409 REFERENCE_RESTRICT if a `restrict`
     *   reference points to the record
     */
    async delete(id) {
        return this.db.delete(this.collection, id);
    }
}
