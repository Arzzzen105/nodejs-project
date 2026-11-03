import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validators/id-params.js';
import {
    createEducator,
    updateEducator,
} from '../validators/educator-schemas.js';
import { listQuery } from '../validators/list-query.js';

/**
 * Routes of /api/educators.
 * @param {import('../controllers/educator-controller.js').EducatorController} controller
 * @returns {import('express').Router}
 */
export function createEducatorRouter(controller) {
    const router = Router();

    router.get('/', validate({ query: listQuery }), controller.list);
    router.post('/', validate({ body: createEducator }), controller.create);
    router.get('/:id', validate({ params: idParams }), controller.get);
    router.put(
        '/:id',
        validate({ params: idParams, body: createEducator }),
        controller.replace
    );
    router.patch(
        '/:id',
        validate({ params: idParams, body: updateEducator }),
        controller.update
    );
    router.delete('/:id', validate({ params: idParams }), controller.delete);

    return router;
}
