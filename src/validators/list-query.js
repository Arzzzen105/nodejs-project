import { z } from 'zod';

/**
 * Query string of list endpoints: `?where={"age":3}&sort=-age&limit=20&offset=40`.
 * Only turns strings into values: field names, operators and the range of
 * `limit` and `offset` are checked by the database.
 */
export const listQuery = z.strictObject({
    where: z
        .string()
        .transform((value, context) => {
            try {
                return JSON.parse(value);
            } catch {
                context.addIssue({
                    code: 'custom',
                    message: 'Must be valid JSON.',
                });
                return z.NEVER;
            }
        })
        .pipe(z.record(z.string(), z.unknown()))
        .optional(),
    // "?sort=lastName,-age" or "?sort=lastName&sort=-age"
    sort: z.union([z.string(), z.array(z.string())]).optional(),
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().optional(),
});
