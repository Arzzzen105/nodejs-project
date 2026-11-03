import { StatusCodes } from 'http-status-codes';

/**
 * @typedef {import('../services/educator-service.js').EducatorService} EducatorService
 */

/**
 * HTTP side of educators: takes what `validate` checked, calls the service and
 * chooses the status. Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class EducatorController {
    #educators;

    /**
     * @param {object} dependencies
     * @param {EducatorService} dependencies.educators
     */
    constructor({ educators }) {
        this.#educators = educators;
    }

    list = async (request, response) => {
        response.json(await this.#educators.list(request.validated.query));
    };

    create = async (request, response) => {
        const educator = await this.#educators.create(request.validated.body);
        response
            .location(`${request.baseUrl}/${educator.id}`)
            .status(StatusCodes.CREATED)
            .json(educator);
    };

    get = async (request, response) => {
        response.json(await this.#educators.get(request.validated.params.id));
    };

    replace = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#educators.replace(params.id, body));
    };

    update = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#educators.update(params.id, body));
    };

    delete = async (request, response) => {
        await this.#educators.delete(request.validated.params.id);
        response.status(StatusCodes.NO_CONTENT).end();
    };
}
