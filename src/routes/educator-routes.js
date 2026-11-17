import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT, ROLES } from '../security/roles.js';
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

    // who may use each route; which records are theirs is checked by the
    // services (AccessPolicy)
    const management = authorize(...MANAGEMENT);
    const themselves = authorize(...MANAGEMENT, ROLES.EDUCATOR);

    router.get(
        '/',
        management,
        validate({ query: listQuery }),
        controller.list
    );
    router.post(
        '/',
        management,
        validate({ body: createEducator }),
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
        validate({ params: idParams, body: createEducator }),
        controller.replace
    );
    router.patch(
        '/:id',
        management,
        validate({ params: idParams, body: updateEducator }),
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
        '/:id/group',
        themselves,
        validate({ params: idParams }),
        controller.getGroup
    );

    return router;
}
