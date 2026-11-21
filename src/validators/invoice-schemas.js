import { z } from 'zod';

/**
 * A month of invoices: `2026-11`.
 */
export const period = z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Must be a month: YYYY-MM.');

/**
 * Body of POST /api/invoices: invoice a kid for a month. Everything else of
 * an invoice is counted by the service.
 */
export const issueInvoice = z.strictObject({
    kidId: z.uuidv7(),
    period,
});

/**
 * Body of POST /api/invoices/batch: invoice every kid in a group for a month.
 */
export const issueInvoices = z.strictObject({ period });
