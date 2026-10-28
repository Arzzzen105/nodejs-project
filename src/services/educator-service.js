/**
 * @typedef {import('../repositories/educator-repository.js').EducatorRepository} EducatorRepository
 */

/**
 * Use cases for educators. For now every method passes the call to the
 * repository as is; business rules of EPIC-02 are added here.
 */
export class EducatorService {
    #educators;

    /**
     * @param {object} dependencies
     * @param {EducatorRepository} dependencies.educators
     */
    constructor({ educators }) {
        this.#educators = educators;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#educators.findPage(query);
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#educators.findById(id);
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return this.#educators.getById(id);
    }

    /** @see BaseRepository#create */
    async create(data) {
        return this.#educators.create(data);
    }

    /** @see BaseRepository#replace */
    async replace(id, data) {
        return this.#educators.replace(id, data);
    }

    /** @see BaseRepository#update */
    async update(id, changes) {
        return this.#educators.update(id, changes);
    }

    /** @see BaseRepository#delete */
    async delete(id) {
        return this.#educators.delete(id);
    }
}
