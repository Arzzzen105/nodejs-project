/**
 * @typedef {import('../repositories/subject-repository.js').SubjectRepository} SubjectRepository
 */

/**
 * Use cases for subjects. For now every method passes the call to the
 * repository as is; business rules of EPIC-02 are added here.
 */
export class SubjectService {
    #subjects;

    /**
     * @param {object} dependencies
     * @param {SubjectRepository} dependencies.subjects
     */
    constructor({ subjects }) {
        this.#subjects = subjects;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#subjects.findPage(query);
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#subjects.findById(id);
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return this.#subjects.getById(id);
    }

    /** @see BaseRepository#create */
    async create(data) {
        return this.#subjects.create(data);
    }

    /** @see BaseRepository#replace */
    async replace(id, data) {
        return this.#subjects.replace(id, data);
    }

    /** @see BaseRepository#update */
    async update(id, changes) {
        return this.#subjects.update(id, changes);
    }

    /** @see BaseRepository#delete */
    async delete(id) {
        return this.#subjects.delete(id);
    }
}
