import { z } from 'zod';

/**
 * Body of POST and PUT /api/groups. Keep the rules in step with
 * database/groups/config.json: tests/validators/group-schemas.test.js compares them.
 *
 * No `.default()` here: `.partial()` would keep it, and PATCH would overwrite
 * the field. Defaults are filled in by the database. References are checked for
 * format only: the database answers 422 REFERENCE_NOT_FOUND for a missing record.
 */
export const createGroup = z.strictObject({
    name: z.string().min(1).max(100),
    age: z.int().min(2).max(5),
    educatorId: z.uuidv7().nullable().optional(),
    assistantId: z.uuidv7().nullable().optional(),
});

/**
 * Body of PATCH /api/groups/:id: the same fields, each of them optional.
 */
export const updateGroup = createGroup.partial();
