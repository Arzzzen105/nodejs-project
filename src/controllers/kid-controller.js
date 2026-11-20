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
    #finance;

    /**
     * @param {object} dependencies
     * @param {KidService} dependencies.kids
     * @param {import('../services/finance-service.js').FinanceService} dependencies.finance
     */
    constructor({ kids, finance }) {
        this.#kids = kids;
        this.#finance = finance;
    }

    /** What the kid costs (FR-012), from the finance service. */
    price = async (request, response) => {
        response.json(
            await this.#finance.kidPrice(
                request.validated.params.id,
                request.user
            )
        );
    };

    list = async (request, response) => {
        response.json(
            await this.#kids.list(request.validated.query, request.user)
        );
    };

    create = async (request, response) => {
        const kid = await this.#kids.create(
            request.validated.body,
            request.user
        );
        response
            .location(`${request.baseUrl}/${kid.id}`)
            .status(StatusCodes.CREATED)
            .json(kid);
    };

    get = async (request, response) => {
        response.json(
            await this.#kids.get(request.validated.params.id, request.user)
        );
    };

    replace = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#kids.replace(params.id, body, request.user));
    };

    update = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#kids.update(params.id, body, request.user));
    };

    delete = async (request, response) => {
        await this.#kids.delete(request.validated.params.id);
        response.status(StatusCodes.NO_CONTENT).end();
    };
}
