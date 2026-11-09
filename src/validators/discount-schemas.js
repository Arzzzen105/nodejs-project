import { z } from 'zod';

/**
 * Body of POST and PUT /api/discounts. Keep the rules in step with
 * database/discounts/config.json: tests/validators/discount-schemas.test.js compares them.
 *
 * `rate` is a share of the tuition fee, from 0 to 1 (0.1 is 10%).
 *
 * No `.default()` here: `.partial()` would keep it, and PATCH would overwrite
 * the field. Defaults are filled in by the database.
 */
export const createDiscount = z.strictObject({
    name: z.string().min(1).max(25),
    rate: z.number().min(0).max(1),
});

/**
 * Body of PATCH /api/discounts/:id: the same fields, each of them optional.
 */
export const updateDiscount = createDiscount.partial();
