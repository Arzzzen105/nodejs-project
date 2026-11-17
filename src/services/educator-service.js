/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/educator-repository.js').EducatorRepository} EducatorRepository
 * @typedef {import('../repositories/group-repository.js').GroupRepository} GroupRepository
 */

/**
 * Use cases for educators. CRUD passes the call to the repository as is;
 * related records are read in one transaction with the check that the
 * educator exists.
 */
export class EducatorService {
    #uow;
    #educators;
    #groups;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {EducatorRepository} dependencies.educators
     * @param {GroupRepository} dependencies.groups
     */
    constructor({ uow, educators, groups }) {
        this.#uow = uow;
        this.#educators = educators;
        this.#groups = groups;
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

    /**
     * The group of the educator, or null if they have none.
     * @see GroupRepository#findByEducator
     * @throws {Error} 404 NOT_FOUND if there is no such educator
     */
    async getGroup(id) {
        return this.#uow.run(async () => {
            await this.#educators.getById(id);
            return this.#groups.findByEducator(id);
        });
    }
}
