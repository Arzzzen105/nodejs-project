import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { ROLES } from '../security/roles.js';
import { idParams } from '../validators/id-params.js';
import { listQuery } from '../validators/list-query.js';
import { createUser } from '../validators/user-schemas.js';

/**
 * Routes of /api/users (FR-022), for the admin and the manager only. The
 * username and the password cannot be changed (BR-67), so there is no PUT or
 * PATCH; which accounts a manager may write is checked by the service.
 * @param {import('../controllers/user-controller.js').UserController} controller
 * @returns {import('express').Router}
 */
export function createUserRouter(controller) {
    const router = Router();

    router.use(authorize(ROLES.ADMIN, ROLES.MANAGER));
    router.get('/', validate({ query: listQuery }), controller.list);
    router.post('/', validate({ body: createUser }), controller.create);
    router.get('/:id', validate({ params: idParams }), controller.get);
    router.delete('/:id', validate({ params: idParams }), controller.delete);

    return router;
}
