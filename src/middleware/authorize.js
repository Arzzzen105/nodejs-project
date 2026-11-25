import { forbidden } from '../http-error.js';

/**
 * Middleware that lets a request through only for the given roles (EPIC-03,
 * TS-03.3). Runs after `authenticate`, which puts the account in
 * `request.user`, and before `validate`: a role that may not use a route
 * learns nothing about its body.
 *
 * Whether a record is the user's own (a parent's kid, an educator's group)
 * needs the database, so services check that, not this middleware.
 * @param {...string} roles Roles allowed, see ROLES
 * @returns {import('express').RequestHandler}
 * @example
 * router.post('/', authorize(ROLES.ADMIN), validate({ body }), controller.create);
 */
export function authorize(...roles) {
    const middleware = (request, response, next) => {
        if (!roles.includes(request.user?.role)) {
            throw forbidden('Your role does not allow this.');
        }
        next();
    };
    // read by the API reference (src/openapi), so it shows the roles that
    // are really checked
    middleware.roles = Object.freeze([...roles]);
    return middleware;
}
