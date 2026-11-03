import { Router } from 'express';

/**
 * Creates the router for assistants endpoints.
 * @param {import('../controllers/assistant-controller.js').AssistantController} controller
 * @returns {Router}
 */
export function createAssistantRoutes(controller) {
    const router = Router();

    router.get('/', controller.list);
    router.post('/', controller.create);
    router.get('/:id', controller.get);
    router.put('/:id', controller.replace);
    router.patch('/:id', controller.update);
    router.delete('/:id', controller.delete);

    return router;
}
