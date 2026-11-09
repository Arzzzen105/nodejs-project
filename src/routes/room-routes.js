import { Router } from 'express';
import { validate } from '../middleware/validate.js';
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

    return router;
}
