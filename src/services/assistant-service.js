/**
 * @typedef {import('../repositories/assistant-repository.js').AssistantRepository} AssistantRepository
 */

/**
 * Use cases for assistants. For now every method passes the call to the
 * repository as is; business rules of EPIC-02 are added here.
 */
export class AssistantService {
    #assistants;

    /**
     * @param {object} dependencies
     * @param {AssistantRepository} dependencies.assistants
     */
    constructor({ assistants }) {
        this.#assistants = assistants;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#assistants.findPage(query);
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#assistants.findById(id);
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return this.#assistants.getById(id);
    }

    /** @see BaseRepository#create */
    async create(data) {
        return this.#assistants.create(data);
    }

    /** @see BaseRepository#replace */
    async replace(id, data) {
        return this.#assistants.replace(id, data);
    }

    /** @see BaseRepository#update */
    async update(id, changes) {
        return this.#assistants.update(id, changes);
    }

    /** @see BaseRepository#delete */
    async delete(id) {
        return this.#assistants.delete(id);
    }
}
