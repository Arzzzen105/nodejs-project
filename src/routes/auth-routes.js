import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { login } from '../validators/auth-schemas.js';

/**
 * Routes of /api/auth. Logging in is the only route of the API that needs no
 * token.
 * @param {import('../controllers/auth-controller.js').AuthController} controller
 * @param {import('express').RequestHandler} authenticate
 * @returns {import('express').Router}
 */
export function createAuthRouter(controller, authenticate) {
    const router = Router();

    router.post('/login', validate({ body: login }), controller.login);
    router.get('/me', authenticate, controller.me);

    return router;
}
