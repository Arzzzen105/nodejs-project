/**
 * @typedef {object} Operation A route of the API as the reference sees it
 * @property {string} method `get`, `post`…
 * @property {string} path In the form of OpenAPI: `/api/kids/{id}`
 * @property {string} mount Where its router is mounted: `/api/kids`
 * @property {string[]|null} roles Roles `authorize` lets in; null for any
 *   account
 * @property {boolean} open Needs no token
 * @property {{ params?: import('zod').ZodType, query?: import('zod').ZodType, body?: import('zod').ZodType }} schemas
 *   What `validate` checks
 */

/**
 * Every route of the routers, read from the routers themselves: the roles of
 * `authorize`, the schemas of `validate` and whether `authenticate` runs. So
 * the reference shows what is really checked, not what someone wrote down.
 * @param {import('../routes/api-routers.js').ApiRouter[]} routers
 * @returns {Operation[]} In the order of the routers and their routes
 */
export function collectOperations(routers) {
    const operations = [];
    for (const { path: mount, router, open = false } of routers) {
        // `router.use(authorize(...))` applies to the routes after it
        let routerRoles = null;
        for (const layer of router.stack) {
            if (!layer.route) {
                routerRoles = within(routerRoles, layer.handle.roles);
                continue;
            }
            let roles = routerRoles;
            let schemas = {};
            let needsToken = !open;
            for (const { handle } of layer.route.stack) {
                roles = within(roles, handle.roles);
                if (handle.schemas) schemas = handle.schemas;
                if (handle.authenticates) needsToken = true;
            }
            const path = toOpenApi(
                layer.route.path === '/' ? mount : mount + layer.route.path
            );
            for (const method of Object.keys(layer.route.methods)) {
                operations.push({
                    method,
                    path,
                    mount,
                    roles,
                    open: !needsToken,
                    schemas,
                });
            }
        }
    }
    return operations;
}

/**
 * Roles let in by two checks one after another.
 * @param {string[]|null} roles So far; null for any
 * @param {string[]} [more] Of the next check
 */
function within(roles, more) {
    if (!more) return roles;
    return roles ? roles.filter((role) => more.includes(role)) : [...more];
}

/**
 * @param {string} path Of Express: `/api/kids/:kidId/notes/:id`
 * @returns {string} Of OpenAPI: `/api/kids/{kidId}/notes/{id}`
 */
export function toOpenApi(path) {
    return path.replace(/:(\w+)/g, '{$1}');
}
