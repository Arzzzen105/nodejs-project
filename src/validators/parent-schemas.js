import { z } from 'zod';

/**
 * Body of POST and PUT /api/parents. Keep the rules in step with
 * database/parents/config.json: tests/validators/parent-schemas.test.js compares them.
 *
 * No `.default()` here: `.partial()` would keep it, and PATCH would overwrite
 * the field. Defaults are filled in by the database.
 */
export const createParent = z.strictObject({
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    sex: z.enum(['MALE', 'FEMALE']),
    workplace: z.string().min(1).max(200).nullable().optional(),

    email: z
        .string()
        .max(100)
        .regex(
            /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
            'Invalid email format'
        )
        .nullable()
        .optional(),

    phone: z
        .string()
        .max(25)
        .regex(/^\+?[0-9\s\-()]{7,20}$/, 'Invalid phone format')
        .nullable()
        .optional(),
});

/**
 * Body of PATCH /api/parents/:id: the same fields, each of them optional.
 */
export const updateParent = createParent.partial();
