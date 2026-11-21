/**
 * @typedef {import('../services/change-service.js').ChangeService} ChangeService
 */

/**
 * HTTP side of the history of changes: takes what `validate` checked and
 * calls the service. Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class ChangeController {
    #changes;

    /**
     * @param {object} dependencies
     * @param {ChangeService} dependencies.changes
     */
    constructor({ changes }) {
        this.#changes = changes;
    }

    list = async (request, response) => {
        response.json(await this.#changes.list(request.validated.query));
    };
}
