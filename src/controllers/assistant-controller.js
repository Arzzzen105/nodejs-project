/**
 * Controller for assistants HTTP endpoints.
 */
export class AssistantController {
    #assistants;

    /**
     * @param {object} dependencies
     * @param {import('../services/assistant-service.js').AssistantService} dependencies.assistants
     */
    constructor({ assistants }) {
        this.#assistants = assistants;

        // Прив'язка контексту, щоб методи безпечно працювали як роутери Express
        this.list = this.list.bind(this);
        this.get = this.get.bind(this);
        this.create = this.create.bind(this);
        this.replace = this.replace.bind(this);
        this.update = this.update.bind(this);
        this.delete = this.delete.bind(this);
    }

    async list(req, res, next) {
        try {
            const result = await this.#assistants.list(req.query);
            res.json(result);
        } catch (error) {
            next(error);
        }
    }

    async get(req, res, next) {
        try {
            const item = await this.#assistants.get(req.params.id);
            res.json(item);
        } catch (error) {
            next(error);
        }
    }

    async create(req, res, next) {
        try {
            const newItem = await this.#assistants.create(req.body);
            res.status(201).json(newItem);
        } catch (error) {
            next(error);
        }
    }

    async replace(req, res, next) {
        try {
            const updated = await this.#assistants.replace(
                req.params.id,
                req.body
            );
            res.json(updated);
        } catch (error) {
            next(error);
        }
    }

    async update(req, res, next) {
        try {
            const updated = await this.#assistants.update(
                req.params.id,
                req.body
            );
            res.json(updated);
        } catch (error) {
            next(error);
        }
    }

    async delete(req, res, next) {
        try {
            await this.#assistants.delete(req.params.id);
            res.status(204).send();
        } catch (error) {
            next(error);
        }
    }
}
