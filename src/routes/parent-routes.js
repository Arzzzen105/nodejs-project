import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT } from '../security/roles.js';
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

    router.use(authorize(...MANAGEMENT));

    router.get('/', validate({ query: listQuery }), controller.list);
    router.post('/', validate({ body: createParent }), controller.create);
    router.get('/:id', validate({ params: idParams }), controller.get);
    router.put(
        '/:id',
        validate({ params: idParams, body: createParent }),
        controller.replace
    );
    router.patch(
        '/:id',
        validate({ params: idParams, body: updateParent }),
        controller.update
    );
    router.delete('/:id', validate({ params: idParams }), controller.delete);

    // related records, read only
    router.get(
        '/:id/kids',
        validate({ params: idParams, query: listQuery }),
        controller.listKids
    );

    return router;
}
