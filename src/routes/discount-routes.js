import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT, ROLES } from '../security/roles.js';
import { idParams } from '../validators/id-params.js';
import {
    createDiscount,
    updateDiscount,
} from '../validators/discount-schemas.js';
import { listQuery } from '../validators/list-query.js';

/**
 * Routes of /api/discounts. The manager reads discounts, only the admin
 * changes them: they are financial values (BR-26).
 * @param {import('../controllers/discount-controller.js').DiscountController} controller
 * @returns {import('express').Router}
 */
export function createDiscountRouter(controller) {
    const router = Router();

    router.use(authorize(...MANAGEMENT));

    router.get('/', validate({ query: listQuery }), controller.list);
    router.post(
        '/',
        authorize(ROLES.ADMIN),
        validate({ body: createDiscount }),
        controller.create
    );
    router.get('/:id', validate({ params: idParams }), controller.get);
    router.put(
        '/:id',
        authorize(ROLES.ADMIN),
        validate({ params: idParams, body: createDiscount }),
        controller.replace
    );
    router.patch(
        '/:id',
        authorize(ROLES.ADMIN),
        validate({ params: idParams, body: updateDiscount }),
        controller.update
    );
    router.delete(
        '/:id',
        authorize(ROLES.ADMIN),
        validate({ params: idParams }),
        controller.delete
    );

    // related records, read only
    router.get(
        '/:id/kids',
        validate({ params: idParams, query: listQuery }),
        controller.listKids
    );

    return router;
}
