import { mergeReports } from './delete-report.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/educator-repository.js').EducatorRepository} EducatorRepository
 * @typedef {import('./group-service.js').GroupService} GroupService
 * @typedef {import('../repositories/user-repository.js').UserRepository} UserRepository
 * @typedef {import('./access-policy.js').AccessPolicy} AccessPolicy
 */

/**
 * Use cases for educators. CRUD passes the call to the repository as is;
 * related records are read in one transaction with the check that the
 * educator exists. Deleting an educator also deletes their account.
 */
export class EducatorService {
    #uow;
    #educators;
    #groupService;
    #users;
    #access;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {EducatorRepository} dependencies.educators
     * @param {GroupService} dependencies.groupService Groups come with
     *   their derived fields from there
     * @param {UserRepository} dependencies.users
     * @param {AccessPolicy} dependencies.access Which records the
     *   actor sees
     */
    constructor({ uow, educators, groupService, users, access }) {
        this.#uow = uow;
        this.#educators = educators;
        this.#groupService = groupService;
        this.#users = users;
        this.#access = access;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#educators.findPage(query);
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#educators.findById(id);
    }

    /**
     * @see BaseRepository#getById
     * @param {string} id UUIDv7
     * @param {import('./access-policy.js').Actor} [actor]
     * @throws {HttpError} 403 FORBIDDEN if an educator asks for another one
     */
    async get(id, actor) {
        const educator = await this.#educators.getById(id);
        this.#access.assertSelf(actor, 'educatorId', id);
        return educator;
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
        return this.#uow.run(async () => {
            const reports = await this.#users.deleteByPerson({
                educatorId: id,
            });
            reports.push(await this.#educators.delete(id));
            return mergeReports(reports);
        });
    }

    /**
     * The group of the educator, or null if they have none.
     * @see GroupService#findByEducator
     * @throws {Error} 404 NOT_FOUND if there is no such educator
     * @param {import('./access-policy.js').Actor} [actor]
     * @throws {HttpError} 403 FORBIDDEN if an educator asks for another one
     */
    async getGroup(id, actor) {
        return this.#uow.run(async () => {
            await this.#educators.getById(id);
            this.#access.assertSelf(actor, 'educatorId', id);
            return this.#groupService.findByEducator(id);
        });
    }
}
