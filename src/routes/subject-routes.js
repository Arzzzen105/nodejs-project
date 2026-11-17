import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT } from '../security/roles.js';
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

    router.use(authorize(...MANAGEMENT));

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

    // related records, read only
    router.get(
        '/:id/teachers',
        validate({ params: idParams, query: listQuery }),
        controller.listTeachers
    );
    router.get(
        '/:id/rooms',
        validate({ params: idParams, query: listQuery }),
        controller.listRooms
    );

    return router;
}
