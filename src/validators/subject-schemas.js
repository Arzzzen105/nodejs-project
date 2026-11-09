import { z } from 'zod';

/**
 * Body of POST and PUT /api/subjects. Keep the rules in step with
 * database/subjects/config.json: tests/validators/subject-schemas.test.js compares them.
 *
 * No `.default()` here: `.partial()` would keep it, and PATCH would overwrite
 * the field. Defaults are filled in by the database.
 */
export const createSubject = z.strictObject({
    name: z.string().min(1).max(30),
});

/**
 * Body of PATCH /api/subjects/:id: the same fields, each of them optional.
 */
export const updateSubject = createSubject.partial();
