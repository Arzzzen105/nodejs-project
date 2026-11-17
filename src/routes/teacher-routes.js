import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT, ROLES } from '../security/roles.js';
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

    // who may use each route; which records are theirs is checked by the
    // services (AccessPolicy)
    const management = authorize(...MANAGEMENT);
    const themselves = authorize(...MANAGEMENT, ROLES.TEACHER);

    router.get(
        '/',
        management,
        validate({ query: listQuery }),
        controller.list
    );
    router.post(
        '/',
        management,
        validate({ body: createTeacher }),
        controller.create
    );
    router.get(
        '/:id',
        themselves,
        validate({ params: idParams }),
        controller.get
    );
    router.put(
        '/:id',
        management,
        validate({ params: idParams, body: createTeacher }),
        controller.replace
    );
    router.patch(
        '/:id',
        management,
        validate({ params: idParams, body: updateTeacher }),
        controller.update
    );
    router.delete(
        '/:id',
        management,
        validate({ params: idParams }),
        controller.delete
    );

    return router;
}
