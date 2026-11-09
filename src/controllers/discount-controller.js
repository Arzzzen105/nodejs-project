import { StatusCodes } from 'http-status-codes';

/**
 * @typedef {import('../services/discount-service.js').DiscountService} DiscountService
 */

/**
 * HTTP side of discounts: takes what `validate` checked, calls the service and
 * chooses the status. Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class DiscountController {
    #discounts;

    /**
     * @param {object} dependencies
     * @param {DiscountService} dependencies.discounts
     */
    constructor({ discounts }) {
        this.#discounts = discounts;
    }

    list = async (request, response) => {
        response.json(await this.#discounts.list(request.validated.query));
    };

    create = async (request, response) => {
        const discount = await this.#discounts.create(request.validated.body);
        response
            .location(`${request.baseUrl}/${discount.id}`)
            .status(StatusCodes.CREATED)
            .json(discount);
    };

    get = async (request, response) => {
        response.json(await this.#discounts.get(request.validated.params.id));
    };

    replace = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#discounts.replace(params.id, body));
    };

    update = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#discounts.update(params.id, body));
    };

    delete = async (request, response) => {
        await this.#discounts.delete(request.validated.params.id);
        response.status(StatusCodes.NO_CONTENT).end();
    };
}
