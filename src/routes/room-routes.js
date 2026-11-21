import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT } from '../security/roles.js';
import { idParams } from '../validators/id-params.js';
import { createRoom, updateRoom } from '../validators/room-schemas.js';
import { listQuery } from '../validators/list-query.js';

/**
 * Routes of /api/rooms.
 * @param {import('../controllers/room-controller.js').RoomController} controller
 * @returns {import('express').Router}
 */
export function createRoomRouter(controller) {
    const router = Router();

    router.use(authorize(...MANAGEMENT));

    router.get('/', validate({ query: listQuery }), controller.list);
    router.post('/', validate({ body: createRoom }), controller.create);
    router.get('/:id', validate({ params: idParams }), controller.get);
    router.put(
        '/:id',
        validate({ params: idParams, body: createRoom }),
        controller.replace
    );
    router.patch(
        '/:id',
        validate({ params: idParams, body: updateRoom }),
        controller.update
    );
    router.delete('/:id', validate({ params: idParams }), controller.delete);

    // when the room is taken by the published timetable (FR-009)
    router.get(
        '/:id/schedule',
        validate({ params: idParams }),
        controller.schedule
    );

    return router;
}
