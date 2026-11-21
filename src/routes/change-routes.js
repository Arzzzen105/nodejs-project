import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { ROLES } from '../security/roles.js';
import { changesQuery } from '../validators/change-schemas.js';

/**
 * Routes of /api/changes (FR-15). The history holds whole records with
 * personal data, so it is for the admin only.
 * @param {import('../controllers/change-controller.js').ChangeController} controller
 * @returns {import('express').Router}
 */
export function createChangeRouter(controller) {
    const router = Router();

    router.use(authorize(ROLES.ADMIN));
    router.get('/', validate({ query: changesQuery }), controller.list);

    return router;
}
