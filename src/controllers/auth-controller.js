/**
 * @typedef {import('../services/auth-service.js').AuthService} AuthService
 */

/**
 * HTTP side of logging in (EPIC-03): takes what `validate` checked, calls the
 * service. Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class AuthController {
    #auth;

    /**
     * @param {object} dependencies
     * @param {AuthService} dependencies.auth
     */
    constructor({ auth }) {
        this.#auth = auth;
    }

    login = async (request, response) => {
        const { username, password } = request.validated.body;
        response.json(await this.#auth.login(username, password));
    };

    /** The account of the request, put there by `authenticate`. */
    me = async (request, response) => {
        response.json(request.user);
    };
}
