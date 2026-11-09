import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { listQuery } from '../validators/list-query.js';
import {
    createNote,
    kidParams,
    noteParams,
    updateNote,
} from '../validators/note-schemas.js';

/**
 * Routes of /api/kids/:kidId/notes. `mergeParams` gives them the `kidId` of
 * the path where the router is mounted.
 * @param {import('../controllers/note-controller.js').NoteController} controller
 * @returns {import('express').Router}
 */
export function createNoteRouter(controller) {
    const router = Router({ mergeParams: true });

    router.get(
        '/',
        validate({ params: kidParams, query: listQuery }),
        controller.list
    );
    router.post(
        '/',
        validate({ params: kidParams, body: createNote }),
        controller.create
    );
    router.get('/:id', validate({ params: noteParams }), controller.get);
    router.put(
        '/:id',
        validate({ params: noteParams, body: createNote }),
        controller.replace
    );
    router.patch(
        '/:id',
        validate({ params: noteParams, body: updateNote }),
        controller.update
    );
    router.delete('/:id', validate({ params: noteParams }), controller.delete);

    return router;
}
