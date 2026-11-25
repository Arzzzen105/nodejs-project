import { z } from 'zod';

/**
 * Body of POST /api/payments: which invoices are paid and how. The sum, the
 * kid and the time are counted by the service.
 */
export const createPayment = z.strictObject({
    invoiceIds: z.array(z.uuidv7()).min(1).max(24),
    method: z.enum(['CARD', 'CASH']),
});

/**
 * The `Idempotency-Key` header of POST /api/payments (NFR-11): any string
 * the client picks for the operation, e.g. a UUID. Optional.
 */
export const idempotencyKey = z.string().min(1).max(100).optional();
