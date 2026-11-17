import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT } from '../security/roles.js';
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

    router.use(authorize(...MANAGEMENT));

    router.get('/', validate({ query: listGroupsQuery }), controller.list);
    router.post('/', validate({ body: createGroup }), controller.create);
    router.get('/:id', validate({ params: idParams }), controller.get);
    router.put(
        '/:id',
        validate({ params: idParams, body: createGroup }),
        controller.replace
    );
    router.patch(
        '/:id',
        validate({ params: idParams, body: updateGroup }),
        controller.update
    );
    router.delete('/:id', validate({ params: idParams }), controller.delete);

    // related records, read only
    router.get(
        '/:id/kids',
        validate({ params: idParams, query: listQuery }),
        controller.listKids
    );
    router.get('/:id/room', validate({ params: idParams }), controller.getRoom);

    // several kids join the group at once (FR-020)
    router.post(
        '/:id/kids',
        validate({ params: idParams, body: addKids }),
        controller.addKids
    );

    return router;
}
