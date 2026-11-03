import { z } from 'zod';

/**
 * Body of POST and PUT /api/kids. Keep the rules in step with
 * database/kids/config.json: tests/validators/kid-schemas.test.js compares them.
 *
 * No `.default()` here: `.partial()` would keep it, and PATCH would overwrite
 * the field. Defaults are filled in by the database. References are checked for
 * format only: the database answers 422 REFERENCE_NOT_FOUND for a missing record.
 */
export const createKid = z.strictObject({
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    age: z.int().min(2).max(5),
    sex: z.enum(['MALE', 'FEMALE']),
    needsSpeechLessons: z.boolean().optional(),
    groupId: z.uuidv7().nullable().optional(),
    discountId: z.uuidv7().nullable().optional(),
    motherId: z.uuidv7().nullable().optional(),
    fatherId: z.uuidv7().nullable().optional(),
});

/**
 * Body of PATCH /api/kids/:id: the same fields, each of them optional.
 */
export const updateKid = createKid.partial();
