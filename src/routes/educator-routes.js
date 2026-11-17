import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT } from '../security/roles.js';
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

    router.use(authorize(...MANAGEMENT));

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

    // related records, read only
    router.get(
        '/:id/group',
        validate({ params: idParams }),
        controller.getGroup
    );

    return router;
}
