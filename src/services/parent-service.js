/**
 * @typedef {import('../repositories/parent-repository.js').ParentRepository} ParentRepository
 */

/**
 * Use cases for parents. For now every method passes the call to the
 * repository as is; business rules of EPIC-02 are added here.
 */
export class ParentService {
    #parents;

    /**
     * @param {object} dependencies
     * @param {ParentRepository} dependencies.parents
     */
    constructor({ parents }) {
        this.#parents = parents;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#parents.findPage(query);
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#parents.findById(id);
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return this.#parents.getById(id);
    }

    /** @see BaseRepository#create */
    async create(data) {
        return this.#parents.create(data);
    }

    /** @see BaseRepository#replace */
    async replace(id, data) {
        return this.#parents.replace(id, data);
    }

    /** @see BaseRepository#update */
    async update(id, changes) {
        return this.#parents.update(id, changes);
    }

    /** @see BaseRepository#delete */
    async delete(id) {
        return this.#parents.delete(id);
    }
}
