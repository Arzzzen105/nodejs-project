import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT, ROLES } from '../security/roles.js';
import { idParams } from '../validators/id-params.js';
import { listQuery } from '../validators/list-query.js';
import {
    entryParams,
    generateSchedule,
    moveEntry,
} from '../validators/schedule-schemas.js';

/**
 * Routes of /api/schedules (FR-006). The admin and the manager generate,
 * edit and publish; a teacher sees and moves their own lessons of a draft
 * (2.4 of the requirements), which the service checks.
 * @param {import('../controllers/schedule-controller.js').ScheduleController} controller
 * @returns {import('express').Router}
 */
export function createScheduleRouter(controller) {
    const router = Router();

    const management = authorize(...MANAGEMENT);
    const teachers = authorize(...MANAGEMENT, ROLES.TEACHER);

    router.get(
        '/',
        management,
        validate({ query: listQuery }),
        controller.list
    );
    router.post(
        '/',
        management,
        validate({ body: generateSchedule }),
        controller.generate
    );
    // the current draft and the published one, without their ids; before
    // '/:id', which would take "draft" for an id
    router.get('/draft', teachers, controller.current('DRAFT'));
    router.get('/published', teachers, controller.current('PUBLISHED'));
    router.get(
        '/:id',
        teachers,
        validate({ params: idParams }),
        controller.get
    );
    router.patch(
        '/:id/entries/:entryId',
        teachers,
        validate({ params: entryParams, body: moveEntry }),
        controller.moveEntry
    );
    router.post(
        '/:id/publish',
        management,
        validate({ params: idParams }),
        controller.publish
    );

    return router;
}
