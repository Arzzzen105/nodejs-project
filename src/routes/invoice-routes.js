import { Router } from 'express';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { MANAGEMENT, ROLES } from '../security/roles.js';
import { idParams } from '../validators/id-params.js';
import { listQuery } from '../validators/list-query.js';
import { issueInvoice, issueInvoices } from '../validators/invoice-schemas.js';

/**
 * Routes of /api/invoices (EPIC-06).
 * @param {import('../controllers/invoice-controller.js').InvoiceController} controller
 * @returns {import('express').Router}
 */
export function createInvoiceRouter(controller) {
    const router = Router();

    // the parents see the invoices of their kids (AccessPolicy)
    const management = authorize(...MANAGEMENT);
    const readers = authorize(...MANAGEMENT, ROLES.PARENT);

    router.get('/', readers, validate({ query: listQuery }), controller.list);
    router.post(
        '/',
        management,
        validate({ body: issueInvoice }),
        controller.issue
    );
    router.post(
        '/batch',
        management,
        validate({ body: issueInvoices }),
        controller.issueAll
    );
    router.get('/:id', readers, validate({ params: idParams }), controller.get);
    router.delete(
        '/:id',
        management,
        validate({ params: idParams }),
        controller.delete
    );

    return router;
}
