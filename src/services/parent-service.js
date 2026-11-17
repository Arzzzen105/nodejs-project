import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/parent-repository.js').ParentRepository} ParentRepository
 * @typedef {import('../repositories/kid-repository.js').KidRepository} KidRepository
 */

/**
 * Use cases for parents. Writes check the business rules on top of what the
 * database checks (schema):
 * - the sex of a parent who is already the mother or father of a kid does
 *   not change, so every kid keeps a FEMALE mother and a MALE father (BR-12).
 * Each write runs in one transaction, so the checked records cannot change
 * before the write.
 */
export class ParentService {
    #uow;
    #parents;
    #kids;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {ParentRepository} dependencies.parents
     * @param {KidRepository} dependencies.kids
     */
    constructor({ uow, parents, kids }) {
        this.#uow = uow;
        this.#parents = parents;
        this.#kids = kids;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#parents.findPage(query);
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#parents.findById(id);
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return this.#parents.getById(id);
    }

    /** @see BaseRepository#create */
    async create(data) {
        return this.#parents.create(data);
    }

    /**
     * @see BaseRepository#replace
     * @throws {HttpError} 409 PARENT_SEX_LOCKED
     */
    async replace(id, data) {
        return this.#uow.run(async () => {
            await this.#assertSexKept(await this.#parents.getById(id), data);
            return this.#parents.replace(id, data);
        });
    }

    /**
     * @see BaseRepository#update
     * @throws {HttpError} 409 PARENT_SEX_LOCKED
     */
    async update(id, changes) {
        return this.#uow.run(async () => {
            await this.#assertSexKept(await this.#parents.getById(id), changes);
            return this.#parents.update(id, changes);
        });
    }

    /** @see BaseRepository#delete */
    async delete(id) {
        return this.#parents.delete(id);
    }

    /**
     * @param {object} current The parent before the write
     * @param {object} next Fields of the write; `sex` may be left out
     */
    async #assertSexKept(current, next) {
        if (next.sex === undefined || next.sex === current.sex) return;
        if ((await this.#kids.countByParent(current.id)) > 0) {
            throw new HttpError(
                StatusCodes.CONFLICT,
                'PARENT_SEX_LOCKED',
                'The sex of a parent cannot change while they are the mother or father of a kid.'
            );
        }
    }

    /**
     * A page of the kids of the parent, as the mother or as the father.
     * @see KidRepository#findPageByParent
     * @throws {Error} 404 NOT_FOUND if there is no such parent
     */
    async listKids(id, query) {
        return this.#uow.run(async () => {
            await this.#parents.getById(id);
            return this.#kids.findPageByParent(id, query);
        });
    }
}
