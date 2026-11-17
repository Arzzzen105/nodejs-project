import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/note-repository.js').NoteRepository} NoteRepository
 * @typedef {import('../repositories/kid-repository.js').KidRepository} KidRepository
 * @typedef {import('./access-policy.js').AccessPolicy} AccessPolicy
 */

/**
 * Use cases for notes about a kid. A note exists only with its kid, so every
 * method takes the id of the kid:
 * - listing or adding notes of a missing kid answers 404;
 * - a note of another kid answers 404, as if there were no such note;
 * - a note cannot be moved to another kid;
 * - the actor works only with notes of the kids they see (AccessPolicy):
 *   an educator reads those of their group, a parent writes about their own
 *   kids. The router decides who may write at all.
 * Deleting a kid deletes their notes (KidService, FR-018).
 */
export class NoteService {
    #uow;
    #notes;
    #kids;
    #access;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {NoteRepository} dependencies.notes
     * @param {KidRepository} dependencies.kids
     * @param {AccessPolicy} dependencies.access Which records the
     *   actor sees
     */
    constructor({ uow, notes, kids, access }) {
        this.#uow = uow;
        this.#notes = notes;
        this.#kids = kids;
        this.#access = access;
    }

    /**
     * Notes of a kid. A `kidId` in `query.where` is overridden.
     * @see BaseRepository#findPage
     * @throws {Error} 404 NOT_FOUND if there is no such kid
     * @throws {HttpError} 403 FORBIDDEN if the kid is not one the actor sees
     */
    async list(kidId, query = {}, actor) {
        return this.#uow.run(async () => {
            await this.#getKid(kidId, actor);
            return this.#notes.findPage({
                ...query,
                where: { ...query.where, kidId },
            });
        });
    }

    /**
     * @see BaseRepository#getById
     * @throws {Error} 404 NOT_FOUND if the kid has no such note
     */
    async get(kidId, id, actor) {
        return this.#uow.run(async () => {
            await this.#getKid(kidId, actor);
            return this.#getOwn(kidId, id);
        });
    }

    /**
     * @see BaseRepository#create
     * @throws {Error} 404 NOT_FOUND if there is no such kid
     */
    async create(kidId, data, actor) {
        return this.#uow.run(async () => {
            await this.#getKid(kidId, actor);
            return this.#notes.create({ ...data, kidId });
        });
    }

    /**
     * @see BaseRepository#replace
     * @throws {Error} 404 NOT_FOUND if the kid has no such note
     */
    async replace(kidId, id, data, actor) {
        return this.#uow.run(async () => {
            await this.#getKid(kidId, actor);
            await this.#getOwn(kidId, id);
            return this.#notes.replace(id, { ...data, kidId });
        });
    }

    /**
     * @see BaseRepository#update
     * @throws {Error} 404 NOT_FOUND if the kid has no such note
     */
    async update(kidId, id, changes, actor) {
        return this.#uow.run(async () => {
            await this.#getKid(kidId, actor);
            await this.#getOwn(kidId, id);
            return this.#notes.update(id, changes);
        });
    }

    /**
     * @see BaseRepository#delete
     * @throws {Error} 404 NOT_FOUND if the kid has no such note
     */
    async delete(kidId, id, actor) {
        return this.#uow.run(async () => {
            await this.#getKid(kidId, actor);
            await this.#getOwn(kidId, id);
            return this.#notes.delete(id);
        });
    }

    /**
     * @param {string} kidId UUIDv7
     * @param {import('./access-policy.js').Actor} [actor]
     * @throws {Error} 404 NOT_FOUND if there is no such kid
     * @throws {HttpError} 403 FORBIDDEN if the kid is not one the actor sees
     */
    async #getKid(kidId, actor) {
        const kid = await this.#kids.getById(kidId);
        await this.#access.assertKid(actor, kid);
        return kid;
    }

    /**
     * A note of the kid. A note of another kid is not found either, so its id
     * tells nothing about other kids.
     */
    async #getOwn(kidId, id) {
        const note = await this.#notes.getById(id);
        if (note.kidId !== kidId) {
            throw new HttpError(
                StatusCodes.NOT_FOUND,
                'NOT_FOUND',
                'Record not found.'
            );
        }
        return note;
    }
}
