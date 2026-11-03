import { StatusCodes } from 'http-status-codes';

/**
 * @typedef {import('../services/assistant-service.js').AssistantService} AssistantService
 */

/**
 * HTTP side of assistants: takes what `validate` checked, calls the service and
 * chooses the status. Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class AssistantController {
    #assistants;

    /**
     * @param {object} dependencies
     * @param {AssistantService} dependencies.assistants
     */
    constructor({ assistants }) {
        this.#assistants = assistants;
    }

    list = async (request, response) => {
        response.json(await this.#assistants.list(request.validated.query));
    };

    create = async (request, response) => {
        const assistant = await this.#assistants.create(request.validated.body);
        response
            .location(`${request.baseUrl}/${assistant.id}`)
            .status(StatusCodes.CREATED)
            .json(assistant);
    };

    get = async (request, response) => {
        response.json(await this.#assistants.get(request.validated.params.id));
    };

    replace = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#assistants.replace(params.id, body));
    };

    update = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#assistants.update(params.id, body));
    };

    delete = async (request, response) => {
        await this.#assistants.delete(request.validated.params.id);
        response.status(StatusCodes.NO_CONTENT).end();
    };
}
