/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/assistant-repository.js').AssistantRepository} AssistantRepository
 * @typedef {import('../repositories/group-repository.js').GroupRepository} GroupRepository
 */

/**
 * Use cases for assistants. CRUD passes the call to the repository as is;
 * related records are read in one transaction with the check that the
 * assistant exists.
 */
export class AssistantService {
    #uow;
    #assistants;
    #groups;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {AssistantRepository} dependencies.assistants
     * @param {GroupRepository} dependencies.groups
     */
    constructor({ uow, assistants, groups }) {
        this.#uow = uow;
        this.#assistants = assistants;
        this.#groups = groups;
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

    /**
     * The group of the assistant, or null if they have none.
     * @see GroupRepository#findByAssistant
     * @throws {Error} 404 NOT_FOUND if there is no such assistant
     */
    async getGroup(id) {
        return this.#uow.run(async () => {
            await this.#assistants.getById(id);
            return this.#groups.findByAssistant(id);
        });
    }
}
