import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validators/id-params.js';
import { createTeacher, updateTeacher } from '../validators/teacher-schemas.js';
import { listQuery } from '../validators/list-query.js';

/**
 * Routes of /api/teachers.
 * @param {import('../controllers/teacher-controller.js').TeacherController} controller
 * @returns {import('express').Router}
 */
export function createTeacherRouter(controller) {
    const router = Router();

    router.get('/', validate({ query: listQuery }), controller.list);
    router.post('/', validate({ body: createTeacher }), controller.create);
    router.get('/:id', validate({ params: idParams }), controller.get);
    router.put(
        '/:id',
        validate({ params: idParams, body: createTeacher }),
        controller.replace
    );
    router.patch(
        '/:id',
        validate({ params: idParams, body: updateTeacher }),
        controller.update
    );
    router.delete('/:id', validate({ params: idParams }), controller.delete);

    return router;
}
