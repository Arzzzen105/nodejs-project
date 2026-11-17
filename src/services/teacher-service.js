import { mergeReports } from './delete-report.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/teacher-repository.js').TeacherRepository} TeacherRepository
 * @typedef {import('../repositories/user-repository.js').UserRepository} UserRepository
 */

/**
 * Use cases for teachers. CRUD passes the call to the repository as is.
 * Deleting a teacher also deletes their account.
 */
export class TeacherService {
    #uow;
    #teachers;
    #users;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {TeacherRepository} dependencies.teachers
     * @param {UserRepository} dependencies.users
     */
    constructor({ uow, teachers, users }) {
        this.#uow = uow;
        this.#teachers = teachers;
        this.#users = users;
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
        return this.#uow.run(async () => {
            const reports = await this.#users.deleteByPerson({
                teacherId: id,
            });
            reports.push(await this.#teachers.delete(id));
            return mergeReports(reports);
        });
    }
}
