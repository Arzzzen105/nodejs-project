import { StatusCodes } from 'http-status-codes';

/**
 * @typedef {import('../services/invoice-service.js').InvoiceService} InvoiceService
 */

/**
 * HTTP side of invoices: takes what `validate` checked, calls the service and
 * chooses the status. Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class InvoiceController {
    #invoices;

    /**
     * @param {object} dependencies
     * @param {InvoiceService} dependencies.invoices
     */
    constructor({ invoices }) {
        this.#invoices = invoices;
    }

    list = async (request, response) => {
        response.json(
            await this.#invoices.list(request.validated.query, request.user)
        );
    };

    get = async (request, response) => {
        response.json(
            await this.#invoices.get(request.validated.params.id, request.user)
        );
    };

    issue = async (request, response) => {
        const { kidId, period } = request.validated.body;
        const items = await this.#invoices.issue(kidId, period);
        response.status(StatusCodes.CREATED).json({ items });
    };

    issueAll = async (request, response) => {
        const result = await this.#invoices.issueAll(
            request.validated.body.period
        );
        // nothing new when every kid was invoiced already
        response
            .status(result.items.length ? StatusCodes.CREATED : StatusCodes.OK)
            .json(result);
    };

    delete = async (request, response) => {
        await this.#invoices.delete(request.validated.params.id);
        response.status(StatusCodes.NO_CONTENT).end();
    };
}
