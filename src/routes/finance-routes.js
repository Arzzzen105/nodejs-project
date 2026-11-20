import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT, ROLES } from '../security/roles.js';
import { updateSettings } from '../validators/settings-schemas.js';

/**
 * Routes of /api/finance (EPIC-04). The manager reads the settings; only the
 * admin changes them (BR-24, BR-40, 2.2 of the requirements).
 * @param {import('../controllers/finance-controller.js').FinanceController} controller
 * @returns {import('express').Router}
 */
export function createFinanceRouter(controller) {
    const router = Router();

    router.get('/settings', authorize(...MANAGEMENT), controller.getSettings);
    router.patch(
        '/settings',
        authorize(ROLES.ADMIN),
        validate({ body: updateSettings }),
        controller.updateSettings
    );

    return router;
}
