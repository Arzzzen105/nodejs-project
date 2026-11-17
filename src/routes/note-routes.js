import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT, ROLES } from '../security/roles.js';
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

    // who may use each route; which records are theirs is checked by the
    // services (AccessPolicy)
    const readers = authorize(...MANAGEMENT, ROLES.EDUCATOR, ROLES.PARENT);
    const writers = authorize(...MANAGEMENT, ROLES.PARENT);

    router.get(
        '/',
        readers,
        validate({ params: kidParams, query: listQuery }),
        controller.list
    );
    router.post(
        '/',
        writers,
        validate({ params: kidParams, body: createNote }),
        controller.create
    );
    router.get(
        '/:id',
        readers,
        validate({ params: noteParams }),
        controller.get
    );
    router.put(
        '/:id',
        writers,
        validate({ params: noteParams, body: createNote }),
        controller.replace
    );
    router.patch(
        '/:id',
        writers,
        validate({ params: noteParams, body: updateNote }),
        controller.update
    );
    router.delete(
        '/:id',
        writers,
        validate({ params: noteParams }),
        controller.delete
    );

    return router;
}
