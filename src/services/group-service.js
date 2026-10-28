/**
 * @typedef {import('../repositories/group-repository.js').GroupRepository} GroupRepository
 */

/**
 * Use cases for groups. For now every method passes the call to the
 * repository as is; business rules of EPIC-02 are added here.
 */
export class GroupService {
    #groups;

    /**
     * @param {object} dependencies
     * @param {GroupRepository} dependencies.groups
     */
    constructor({ groups }) {
        this.#groups = groups;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#groups.findPage(query);
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#groups.findById(id);
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return this.#groups.getById(id);
    }

    /** @see BaseRepository#create */
    async create(data) {
        return this.#groups.create(data);
    }

    /** @see BaseRepository#replace */
    async replace(id, data) {
        return this.#groups.replace(id, data);
    }

    /** @see BaseRepository#update */
    async update(id, changes) {
        return this.#groups.update(id, changes);
    }

    /** @see BaseRepository#delete */
    async delete(id) {
        return this.#groups.delete(id);
    }
}
