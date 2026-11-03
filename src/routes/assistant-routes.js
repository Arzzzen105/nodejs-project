import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import {
    createAssistant,
    updateAssistant,
} from '../validators/assistant-schemas.js';
import { idParams } from '../validators/id-params.js';
import { listQuery } from '../validators/list-query.js';

/**
 * Routes of /api/assistants.
 * @param {import('../controllers/assistant-controller.js').AssistantController} controller
 * @returns {import('express').Router}
 */
export function createAssistantRouter(controller) {
    const router = Router();

    router.get('/', validate({ query: listQuery }), controller.list);
    router.post('/', validate({ body: createAssistant }), controller.create);
    router.get('/:id', validate({ params: idParams }), controller.get);
    router.put(
        '/:id',
        validate({ params: idParams, body: createAssistant }),
        controller.replace
    );
    router.patch(
        '/:id',
        validate({ params: idParams, body: updateAssistant }),
        controller.update
    );
    router.delete('/:id', validate({ params: idParams }), controller.delete);

    return router;
}
