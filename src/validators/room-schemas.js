import { z } from 'zod';

/**
 * Body of POST and PUT /api/rooms. Keep the rules in step with
 * database/rooms/config.json: tests/validators/room-schemas.test.js compares them.
 *
 * No `.default()` here: `.partial()` would keep it, and PATCH would overwrite
 * the field. Defaults are filled in by the database. References are checked for
 * format only: the database answers 422 REFERENCE_NOT_FOUND for a missing record.
 */
export const createRoom = z.strictObject({
    name: z.string().min(1).max(25),
    groupId: z.uuidv7().nullable().optional(),
    subjectIds: z
        .array(z.uuidv7())
        .refine((ids) => new Set(ids).size === ids.length, {
            message: 'Must not contain duplicates.',
        })
        .optional(),
});

/**
 * Body of PATCH /api/rooms/:id: the same fields, each of them optional.
 */
export const updateRoom = createRoom.partial();
