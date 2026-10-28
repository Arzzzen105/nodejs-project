/**
 * @typedef {import('../repositories/teacher-repository.js').TeacherRepository} TeacherRepository
 */

/**
 * Use cases for teachers. For now every method passes the call to the
 * repository as is; business rules of EPIC-02 are added here.
 */
export class TeacherService {
    #teachers;

    /**
     * @param {object} dependencies
     * @param {TeacherRepository} dependencies.teachers
     */
    constructor({ teachers }) {
        this.#teachers = teachers;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#teachers.findPage(query);
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#teachers.findById(id);
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return this.#teachers.getById(id);
    }

    /** @see BaseRepository#create */
    async create(data) {
        return this.#teachers.create(data);
    }

    /** @see BaseRepository#replace */
    async replace(id, data) {
        return this.#teachers.replace(id, data);
    }

    /** @see BaseRepository#update */
    async update(id, changes) {
        return this.#teachers.update(id, changes);
    }

    /** @see BaseRepository#delete */
    async delete(id) {
        return this.#teachers.delete(id);
    }
}
