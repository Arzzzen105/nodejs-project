import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validators/id-params.js';
import { createSubject, updateSubject } from '../validators/subject-schemas.js';
import { listQuery } from '../validators/list-query.js';

/**
 * Routes of /api/subjects.
 * @param {import('../controllers/subject-controller.js').SubjectController} controller
 * @returns {import('express').Router}
 */
export function createSubjectRouter(controller) {
    const router = Router();

    router.get('/', validate({ query: listQuery }), controller.list);
    router.post('/', validate({ body: createSubject }), controller.create);
    router.get('/:id', validate({ params: idParams }), controller.get);
    router.put(
        '/:id',
        validate({ params: idParams, body: createSubject }),
        controller.replace
    );
    router.patch(
        '/:id',
        validate({ params: idParams, body: updateSubject }),
        controller.update
    );
    router.delete('/:id', validate({ params: idParams }), controller.delete);

    return router;
}
