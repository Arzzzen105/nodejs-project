/**
 * @typedef {import('../services/consistency-service.js').ConsistencyService} ConsistencyService
 */

/**
 * HTTP side of the diagnostics (FR-019): takes what `validate` checked, calls
 * the service. Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class ConsistencyController {
    #consistency;

    /**
     * @param {object} dependencies
     * @param {ConsistencyService} dependencies.consistency
     */
    constructor({ consistency }) {
        this.#consistency = consistency;
    }

    summary = async (request, response) => {
        response.json(await this.#consistency.summary());
    };

    /**
     * @param {string} entity
     * @returns {import('express').RequestHandler} The handler of its path
     */
    listOf = (entity) => async (request, response) => {
        response.json(
            await this.#consistency.list(entity, request.validated.query)
        );
    };
}
