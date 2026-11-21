import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT, ROLES } from '../security/roles.js';
import { idParams } from '../validators/id-params.js';
import {
    addKids,
    createGroup,
    listGroupsQuery,
    updateGroup,
} from '../validators/group-schemas.js';
import { listQuery } from '../validators/list-query.js';

/**
 * Routes of /api/groups.
 * @param {import('../controllers/group-controller.js').GroupController} controller
 * @returns {import('express').Router}
 */
export function createGroupRouter(controller) {
    const router = Router();

    // who may use each route; which records are theirs is checked by the
    // services (AccessPolicy)
    const management = authorize(...MANAGEMENT);
    // a teacher reads the groups they teach in (2.4); the timetable of a
    // group is for its educator and parents (2.3, 2.6)
    const readers = authorize(
        ...MANAGEMENT,
        ROLES.EDUCATOR,
        ROLES.PARENT,
        ROLES.TEACHER
    );
    const families = authorize(...MANAGEMENT, ROLES.EDUCATOR, ROLES.PARENT);
    const educators = authorize(...MANAGEMENT, ROLES.EDUCATOR);

    router.get(
        '/',
        readers,
        validate({ query: listGroupsQuery }),
        controller.list
    );
    router.post(
        '/',
        management,
        validate({ body: createGroup }),
        controller.create
    );
    router.get('/:id', readers, validate({ params: idParams }), controller.get);
    router.put(
        '/:id',
        management,
        validate({ params: idParams, body: createGroup }),
        controller.replace
    );
    router.patch(
        '/:id',
        management,
        validate({ params: idParams, body: updateGroup }),
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
        '/:id/kids',
        readers,
        validate({ params: idParams, query: listQuery }),
        controller.listKids
    );
    router.get(
        '/:id/room',
        educators,
        validate({ params: idParams }),
        controller.getRoom
    );
    router.get(
        '/:id/schedule',
        families,
        validate({ params: idParams }),
        controller.schedule
    );

    // several kids join the group at once (FR-020)
    router.post(
        '/:id/kids',
        management,
        validate({ params: idParams, body: addKids }),
        controller.addKids
    );

    return router;
}
