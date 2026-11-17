import { StatusCodes } from 'http-status-codes';

/**
 * @typedef {import('../services/user-service.js').UserService} UserService
 */

/**
 * HTTP side of user accounts (FR-022): takes what `validate` checked, calls
 * the service with the account making the request, and chooses the status.
 * Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class UserController {
    #users;

    /**
     * @param {object} dependencies
     * @param {UserService} dependencies.users
     */
    constructor({ users }) {
        this.#users = users;
    }

    list = async (request, response) => {
        response.json(await this.#users.list(request.validated.query));
    };

    create = async (request, response) => {
        const user = await this.#users.create(
            request.validated.body,
            request.user
        );
        response
            .location(`${request.baseUrl}/${user.id}`)
            .status(StatusCodes.CREATED)
            .json(user);
    };

    get = async (request, response) => {
        response.json(await this.#users.get(request.validated.params.id));
    };

    delete = async (request, response) => {
        await this.#users.delete(request.validated.params.id, request.user);
        response.status(StatusCodes.NO_CONTENT).end();
    };
}
