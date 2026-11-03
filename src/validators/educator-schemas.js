import { z } from 'zod';

/**
 * Body of POST and PUT /api/educators. Keep the rules in step with
 * database/educators/config.json.
 *
 * No `.default()` here: `.partial()` would keep it, and PATCH would overwrite
 * the field. Defaults are filled in by the database.
 */
export const createEducator = z.strictObject({
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
});

/**
 * Body of PATCH /api/educators/:id: the same fields, each of them optional.
 */
export const updateEducator = createEducator.partial();
