import { mergeReports } from './delete-report.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/teacher-repository.js').TeacherRepository} TeacherRepository
 * @typedef {import('../repositories/user-repository.js').UserRepository} UserRepository
 * @typedef {import('./access-policy.js').AccessPolicy} AccessPolicy
 */

/**
 * Use cases for teachers. CRUD passes the call to the repository as is.
 * Deleting a teacher also deletes their account.
 */
export class TeacherService {
    #uow;
    #teachers;
    #users;
    #access;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {TeacherRepository} dependencies.teachers
     * @param {UserRepository} dependencies.users
     * @param {AccessPolicy} dependencies.access Which records the
     *   actor sees
     */
    constructor({ uow, teachers, users, access }) {
        this.#uow = uow;
        this.#teachers = teachers;
        this.#users = users;
        this.#access = access;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#teachers.findPage(query);
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#teachers.findById(id);
    }

    /**
     * @see BaseRepository#getById
     * @param {string} id UUIDv7
     * @param {import('./access-policy.js').Actor} [actor]
     * @throws {HttpError} 403 FORBIDDEN if a teacher asks for another one
     */
    async get(id, actor) {
        const teacher = await this.#teachers.getById(id);
        this.#access.assertSelf(actor, 'teacherId', id);
        return teacher;
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
