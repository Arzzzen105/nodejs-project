import { requestContext } from '../logger.js';
import { unauthenticated } from '../services/auth-service.js';

const BEARER = /^Bearer (\S+)$/i;

/**
 * Middleware that lets a request through only with a valid access token in
 * `Authorization: Bearer <token>`. The account is put in `request.user`, and
 * its id in the request context: logs and the change log (FR-15) then show who
 * made the request.
 * @param {import('../services/auth-service.js').AuthService} auth
 * @returns {import('express').RequestHandler}
 * @example
 * app.use('/api', createAuthenticate(container.services.auth));
 */
export function createAuthenticate(auth) {
    return async (request, response, next) => {
        const token = BEARER.exec(request.get('authorization') ?? '')?.[1];
        if (!token) {
            response.setHeader('www-authenticate', 'Bearer');
            throw unauthenticated('An access token is required.');
        }
        try {
            request.user = await auth.authenticate(token);
        } catch (error) {
            if (error.code === 'UNAUTHENTICATED') {
                response.setHeader(
                    'www-authenticate',
                    'Bearer error="invalid_token"'
                );
            }
            throw error;
        }
        const context = requestContext.getStore();
        if (context) context.userId = request.user.id;
        next();
    };
}
