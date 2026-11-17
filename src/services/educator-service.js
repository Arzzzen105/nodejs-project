import { mergeReports } from './delete-report.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/educator-repository.js').EducatorRepository} EducatorRepository
 * @typedef {import('./group-service.js').GroupService} GroupService
 * @typedef {import('../repositories/user-repository.js').UserRepository} UserRepository
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

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {EducatorRepository} dependencies.educators
     * @param {GroupService} dependencies.groupService Groups come with
     *   their derived fields from there
     * @param {UserRepository} dependencies.users
     */
    constructor({ uow, educators, groupService, users }) {
        this.#uow = uow;
        this.#educators = educators;
        this.#groupService = groupService;
        this.#users = users;
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
     */
    async getGroup(id) {
        return this.#uow.run(async () => {
            await this.#educators.getById(id);
            return this.#groupService.findByEducator(id);
        });
    }
}
