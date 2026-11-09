import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/group-repository.js').GroupRepository} GroupRepository
 */

/**
 * Most groups the kindergarten can take (BR-19): at least 5 of the rooms
 * are kept for classes.
 */
export const MAX_GROUPS = 15;

/**
 * Use cases for groups. Writes check the business rules on top of what the
 * database checks (schema, references, unique name, educator and assistant):
 * - there are at most {@link MAX_GROUPS} groups (BR-19).
 * Each write runs in one transaction, so the checked records cannot change
 * before the write.
 */
export class GroupService {
    #uow;
    #groups;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {GroupRepository} dependencies.groups
     */
    constructor({ uow, groups }) {
        this.#uow = uow;
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

    /**
     * @see BaseRepository#create
     * @throws {HttpError} 409 GROUP_LIMIT_REACHED
     */
    async create(data) {
        return this.#uow.run(async () => {
            if ((await this.#groups.count()) >= MAX_GROUPS) {
                throw new HttpError(
                    StatusCodes.CONFLICT,
                    'GROUP_LIMIT_REACHED',
                    `The kindergarten already has ${MAX_GROUPS} groups.`
                );
            }
            return this.#groups.create(data);
        });
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
