import { z } from 'zod';

/**
 * Body of POST and PUT /api/teachers. Keep the rules in step with
 * database/teachers/config.json: tests/validators/teacher-schemas.test.js compares them.
 *
 * No `.default()` here: `.partial()` would keep it, and PATCH would overwrite
 * the field. Defaults are filled in by the database. References are checked for
 * format only: the database answers 422 REFERENCE_NOT_FOUND for a missing record.
 */
export const createTeacher = z.strictObject({
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    subjectIds: z
        .array(z.uuidv7())
        .refine((ids) => new Set(ids).size === ids.length, {
            message: 'Must not contain duplicates.',
        })
        .optional(),
});

/**
 * Body of PATCH /api/teachers/:id: the same fields, each of them optional.
 */
export const updateTeacher = createTeacher.partial();
