import { Router } from 'express';
import { validate } from '../middleware/validate.js';
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

    router.get('/', validate({ query: listQuery }), controller.list);
    router.post('/', validate({ body: createKid }), controller.create);
    router.get('/:id', validate({ params: idParams }), controller.get);
    router.put(
        '/:id',
        validate({ params: idParams, body: createKid }),
        controller.replace
    );
    router.patch(
        '/:id',
        validate({ params: idParams, body: updateKid }),
        controller.update
    );
    router.delete('/:id', validate({ params: idParams }), controller.delete);

    return router;
}
