import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT } from '../security/roles.js';
import { PROBLEMS } from '../services/consistency-service.js';
import { consistencyQuery } from '../validators/consistency-schemas.js';

/**
 * Routes of /api/consistency (FR-019). Each entity has its own path, so an
 * unknown one answers 404 like any other missing route.
 * @param {import('../controllers/consistency-controller.js').ConsistencyController} controller
 * @returns {import('express').Router}
 */
export function createConsistencyRouter(controller) {
    const router = Router();

    router.use(authorize(...MANAGEMENT));

    router.get('/', controller.summary);
    for (const entity of Object.keys(PROBLEMS)) {
        router.get(
            `/${entity}`,
            validate({ query: consistencyQuery(entity) }),
            controller.listOf(entity)
        );
    }

    return router;
}
