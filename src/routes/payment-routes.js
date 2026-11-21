import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT, ROLES } from '../security/roles.js';
import { idParams } from '../validators/id-params.js';
import { listQuery } from '../validators/list-query.js';
import { createPayment } from '../validators/payment-schemas.js';

/**
 * Routes of /api/payments (EPIC-06). There is no PUT, PATCH or DELETE: a
 * payment is the history of money.
 * @param {import('../controllers/payment-controller.js').PaymentController} controller
 * @returns {import('express').Router}
 */
export function createPaymentRouter(controller) {
    const router = Router();

    // the parents pay and see the payments of their kids (AccessPolicy)
    router.use(authorize(...MANAGEMENT, ROLES.PARENT));

    router.get('/', validate({ query: listQuery }), controller.list);
    router.post('/', validate({ body: createPayment }), controller.create);
    router.get('/:id', validate({ params: idParams }), controller.get);

    return router;
}
