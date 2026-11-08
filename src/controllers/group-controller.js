import { StatusCodes } from 'http-status-codes';

/**
 * @typedef {import('../services/group-service.js').GroupService} GroupService
 */

/**
 * HTTP side of groups: takes what `validate` checked, calls the service and
 * chooses the status. Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class GroupController {
    #groups;

    /**
     * @param {object} dependencies
     * @param {GroupService} dependencies.groups
     */
    constructor({ groups }) {
        this.#groups = groups;
    }

    list = async (request, response) => {
        response.json(await this.#groups.list(request.validated.query));
    };

    create = async (request, response) => {
        const group = await this.#groups.create(request.validated.body);
        response
            .location(`${request.baseUrl}/${group.id}`)
            .status(StatusCodes.CREATED)
            .json(group);
    };

    get = async (request, response) => {
        response.json(await this.#groups.get(request.validated.params.id));
    };

    replace = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#groups.replace(params.id, body));
    };

    update = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#groups.update(params.id, body));
    };

    delete = async (request, response) => {
        await this.#groups.delete(request.validated.params.id);
        response.status(StatusCodes.NO_CONTENT).end();
    };
}
