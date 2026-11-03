import { z } from 'zod';

/**
 * Body of POST and PUT /api/educators. Keep the rules in step with
 * database/educators/config.json: tests/validators/educator-schemas.test.js compares them.
 *
 * No `.default()` here: `.partial()` would keep it, and PATCH would overwrite
 * the field. Defaults are filled in by the database. References are checked for
 * format only: the database answers 422 REFERENCE_NOT_FOUND for a missing record.
 */
export const createEducator = z.strictObject({
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    phone: z.string().min(5).max(30).optional(),
    email: z.string().email().optional(),
    // Якщо у вихователів є спеціалізація або зв'язок з кімнатами/предметами, можна додати тут:
    // roomId: z.uuidv7().nullable().optional(),
});

/**
 * Body of PATCH /api/educators/:id: the same fields, each of them optional.
 */
export const updateEducator = createEducator.partial();
