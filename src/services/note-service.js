import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/note-repository.js').NoteRepository} NoteRepository
 * @typedef {import('../repositories/kid-repository.js').KidRepository} KidRepository
 */

/**
 * Use cases for notes about a kid. A note exists only with its kid, so every
 * method takes the id of the kid:
 * - listing or adding notes of a missing kid answers 404;
 * - a note of another kid answers 404, as if there were no such note;
 * - a note cannot be moved to another kid.
 * Deleting a kid deletes their notes (KidService, FR-018).
 */
export class NoteService {
    #uow;
    #notes;
    #kids;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {NoteRepository} dependencies.notes
     * @param {KidRepository} dependencies.kids
     */
    constructor({ uow, notes, kids }) {
        this.#uow = uow;
        this.#notes = notes;
        this.#kids = kids;
    }

    /**
     * Notes of a kid. A `kidId` in `query.where` is overridden.
     * @see BaseRepository#findPage
     * @throws {Error} 404 NOT_FOUND if there is no such kid
     */
    async list(kidId, query = {}) {
        return this.#uow.run(async () => {
            await this.#kids.getById(kidId);
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
    async get(kidId, id) {
        return this.#getOwn(kidId, id);
    }

    /**
     * @see BaseRepository#create
     * @throws {Error} 404 NOT_FOUND if there is no such kid
     */
    async create(kidId, data) {
        return this.#uow.run(async () => {
            await this.#kids.getById(kidId);
            return this.#notes.create({ ...data, kidId });
        });
    }

    /**
     * @see BaseRepository#replace
     * @throws {Error} 404 NOT_FOUND if the kid has no such note
     */
    async replace(kidId, id, data) {
        return this.#uow.run(async () => {
            await this.#getOwn(kidId, id);
            return this.#notes.replace(id, { ...data, kidId });
        });
    }

    /**
     * @see BaseRepository#update
     * @throws {Error} 404 NOT_FOUND if the kid has no such note
     */
    async update(kidId, id, changes) {
        return this.#uow.run(async () => {
            await this.#getOwn(kidId, id);
            return this.#notes.update(id, changes);
        });
    }

    /**
     * @see BaseRepository#delete
     * @throws {Error} 404 NOT_FOUND if the kid has no such note
     */
    async delete(kidId, id) {
        return this.#uow.run(async () => {
            await this.#getOwn(kidId, id);
            return this.#notes.delete(id);
        });
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
