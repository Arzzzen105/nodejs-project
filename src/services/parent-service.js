import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';
import { mergeReports } from './delete-report.js';
import { narrow } from './access-policy.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/parent-repository.js').ParentRepository} ParentRepository
 * @typedef {import('../repositories/kid-repository.js').KidRepository} KidRepository
 * @typedef {import('../repositories/user-repository.js').UserRepository} UserRepository
 * @typedef {import('./access-policy.js').AccessPolicy} AccessPolicy
 */

/**
 * Use cases for parents. Writes check the business rules on top of what the
 * database checks (schema):
 * - the sex of a parent who is already the mother or father of a kid does
 *   not change, so every kid keeps a FEMALE mother and a MALE father (BR-12).
 * Each write runs in one transaction, so the checked records cannot change
 * before the write.
 * Deleting a parent also deletes their account.
 */
export class ParentService {
    #uow;
    #parents;
    #kids;
    #users;
    #access;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {ParentRepository} dependencies.parents
     * @param {KidRepository} dependencies.kids
     * @param {UserRepository} dependencies.users
     * @param {AccessPolicy} dependencies.access Which records the
     *   actor sees
     */
    constructor({ uow, parents, kids, users, access }) {
        this.#uow = uow;
        this.#parents = parents;
        this.#kids = kids;
        this.#users = users;
        this.#access = access;
    }

    /**
     * The parents the actor sees: all of them for the management, the
     * parents of the kids of their group for an educator, themselves for a
     * parent.
     * @see BaseRepository#findPage
     * @param {object} [query]
     * @param {import('./access-policy.js').Actor} [actor]
     */
    async list(query, actor) {
        return this.#uow.run(async () =>
            this.#parents.findPage(
                narrow(query, await this.#access.parentScope(actor))
            )
        );
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#parents.findById(id);
    }

    /**
     * @see BaseRepository#getById
     * @param {string} id UUIDv7
     * @param {import('./access-policy.js').Actor} [actor]
     * @throws {HttpError} 403 FORBIDDEN if the parent is not one the actor
     *   sees
     */
    async get(id, actor) {
        return this.#uow.run(async () => {
            const parent = await this.#parents.getById(id);
            await this.#access.assertParent(actor, id);
            return parent;
        });
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
        return this.#uow.run(async () => {
            const reports = await this.#users.deleteByPerson({ parentId: id });
            reports.push(await this.#parents.delete(id));
            return mergeReports(reports);
        });
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
     * A page of the kids of the parent, as the mother or as the father. An
     * educator gets only those of their group: a kid of the same parent in
     * another group is not theirs.
     * @see KidRepository#findPageByParent
     * @param {string} id UUIDv7
     * @param {object} [query]
     * @param {import('./access-policy.js').Actor} [actor]
     * @throws {Error} 404 NOT_FOUND if there is no such parent
     * @throws {HttpError} 403 FORBIDDEN if the parent is not one the actor
     *   sees
     */
    async listKids(id, query, actor) {
        return this.#uow.run(async () => {
            await this.#parents.getById(id);
            await this.#access.assertParent(actor, id);
            return this.#kids.findPageByParent(
                id,
                narrow(query, await this.#access.kidScope(actor))
            );
        });
    }
}
