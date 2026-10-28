/**
 * @typedef {import('../repositories/note-repository.js').NoteRepository} NoteRepository
 */

/**
 * Use cases for notes. For now every method passes the call to the
 * repository as is; business rules of EPIC-02 are added here.
 */
export class NoteService {
    #notes;

    /**
     * @param {object} dependencies
     * @param {NoteRepository} dependencies.notes
     */
    constructor({ notes }) {
        this.#notes = notes;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#notes.findPage(query);
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#notes.findById(id);
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return this.#notes.getById(id);
    }

    /** @see BaseRepository#create */
    async create(data) {
        return this.#notes.create(data);
    }

    /** @see BaseRepository#replace */
    async replace(id, data) {
        return this.#notes.replace(id, data);
    }

    /** @see BaseRepository#update */
    async update(id, changes) {
        return this.#notes.update(id, changes);
    }

    /** @see BaseRepository#delete */
    async delete(id) {
        return this.#notes.delete(id);
    }
}
