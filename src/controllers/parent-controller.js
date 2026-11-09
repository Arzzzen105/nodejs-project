import { StatusCodes } from 'http-status-codes';

/**
 * @typedef {import('../services/parent-service.js').ParentService} ParentService
 */

/**
 * HTTP side of parents: takes what `validate` checked, calls the service and
 * chooses the status. Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class ParentController {
    #parents;

    /**
     * @param {object} dependencies
     * @param {ParentService} dependencies.parents
     */
    constructor({ parents }) {
        this.#parents = parents;
    }

    list = async (request, response) => {
        response.json(await this.#parents.list(request.validated.query));
    };

    create = async (request, response) => {
        const parent = await this.#parents.create(request.validated.body);
        response
            .location(`${request.baseUrl}/${parent.id}`)
            .status(StatusCodes.CREATED)
            .json(parent);
    };

    get = async (request, response) => {
        response.json(await this.#parents.get(request.validated.params.id));
    };

    replace = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#parents.replace(params.id, body));
    };

    update = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#parents.update(params.id, body));
    };

    delete = async (request, response) => {
        await this.#parents.delete(request.validated.params.id);
        response.status(StatusCodes.NO_CONTENT).end();
    };
}
