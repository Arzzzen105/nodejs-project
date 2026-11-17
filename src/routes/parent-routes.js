import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT, ROLES } from '../security/roles.js';
import { idParams } from '../validators/id-params.js';
import { createParent, updateParent } from '../validators/parent-schemas.js';
import { listQuery } from '../validators/list-query.js';

/**
 * Routes of /api/parents.
 * @param {import('../controllers/parent-controller.js').ParentController} controller
 * @returns {import('express').Router}
 */
export function createParentRouter(controller) {
    const router = Router();

    // who may use each route; which records are theirs is checked by the
    // services (AccessPolicy)
    const management = authorize(...MANAGEMENT);
    const readers = authorize(...MANAGEMENT, ROLES.EDUCATOR, ROLES.PARENT);

    router.get('/', readers, validate({ query: listQuery }), controller.list);
    router.post(
        '/',
        management,
        validate({ body: createParent }),
        controller.create
    );
    router.get('/:id', readers, validate({ params: idParams }), controller.get);
    router.put(
        '/:id',
        management,
        validate({ params: idParams, body: createParent }),
        controller.replace
    );
    router.patch(
        '/:id',
        management,
        validate({ params: idParams, body: updateParent }),
        controller.update
    );
    router.delete(
        '/:id',
        management,
        validate({ params: idParams }),
        controller.delete
    );

    // related records, read only
    router.get(
        '/:id/kids',
        readers,
        validate({ params: idParams, query: listQuery }),
        controller.listKids
    );

    return router;
}
