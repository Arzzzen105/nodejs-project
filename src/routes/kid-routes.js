import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT, ROLES } from '../security/roles.js';
import { idParams } from '../validators/id-params.js';
import { createKid, updateKid } from '../validators/kid-schemas.js';
import { listQuery } from '../validators/list-query.js';

/**
 * Routes of /api/kids.
 * @param {import('../controllers/kid-controller.js').KidController} controller
 * @returns {import('express').Router}
 */
export function createKidRouter(controller) {
    const router = Router();

    // who may use each route; which records are theirs is checked by the
    // services (AccessPolicy)
    const management = authorize(...MANAGEMENT);
    const readers = authorize(...MANAGEMENT, ROLES.EDUCATOR, ROLES.PARENT);

    router.get('/', readers, validate({ query: listQuery }), controller.list);
    router.post(
        '/',
        management,
        validate({ body: createKid }),
        controller.create
    );
    router.get('/:id', readers, validate({ params: idParams }), controller.get);
    router.put(
        '/:id',
        management,
        validate({ params: idParams, body: createKid }),
        controller.replace
    );
    router.patch(
        '/:id',
        management,
        validate({ params: idParams, body: updateKid }),
        controller.update
    );
    // what the kid costs (FR-012): the parents see it for their own kids
    router.get(
        '/:id/price',
        authorize(...MANAGEMENT, ROLES.PARENT),
        validate({ params: idParams }),
        controller.price
    );
    router.delete(
        '/:id',
        management,
        validate({ params: idParams }),
        controller.delete
    );

    return router;
}
