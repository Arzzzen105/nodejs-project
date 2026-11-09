import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validators/id-params.js';
import {
    createDiscount,
    updateDiscount,
} from '../validators/discount-schemas.js';
import { listQuery } from '../validators/list-query.js';

/**
 * Routes of /api/discounts.
 * @param {import('../controllers/discount-controller.js').DiscountController} controller
 * @returns {import('express').Router}
 */
export function createDiscountRouter(controller) {
    const router = Router();

    router.get('/', validate({ query: listQuery }), controller.list);
    router.post('/', validate({ body: createDiscount }), controller.create);
    router.get('/:id', validate({ params: idParams }), controller.get);
    router.put(
        '/:id',
        validate({ params: idParams, body: createDiscount }),
        controller.replace
    );
    router.patch(
        '/:id',
        validate({ params: idParams, body: updateDiscount }),
        controller.update
    );
    router.delete('/:id', validate({ params: idParams }), controller.delete);

    return router;
}
