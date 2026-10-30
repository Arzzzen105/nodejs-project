import { StatusCodes } from 'http-status-codes';

/**
 * @typedef {import('../services/kid-service.js').KidService} KidService
 */

/**
 * HTTP side of kids: takes what `validate` checked, calls the service and
 * chooses the status. Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class KidController {
    #kids;

    /**
     * @param {object} dependencies
     * @param {KidService} dependencies.kids
     */
    constructor({ kids }) {
        this.#kids = kids;
    }

    list = async (request, response) => {
        response.json(await this.#kids.list(request.validated.query));
    };

    create = async (request, response) => {
        const kid = await this.#kids.create(request.validated.body);
        response
            .location(`${request.baseUrl}/${kid.id}`)
            .status(StatusCodes.CREATED)
            .json(kid);
    };

    get = async (request, response) => {
        response.json(await this.#kids.get(request.validated.params.id));
    };

    replace = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#kids.replace(params.id, body));
    };

    update = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#kids.update(params.id, body));
    };

    delete = async (request, response) => {
        await this.#kids.delete(request.validated.params.id);
        response.status(StatusCodes.NO_CONTENT).end();
    };
}
