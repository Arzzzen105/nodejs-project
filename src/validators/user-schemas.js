import { z } from 'zod';
import { ROLES } from '../security/roles.js';

// bcrypt ignores everything after the 72nd byte of a password
const MAX_PASSWORD_BYTES = 72;

/**
 * Body of POST /api/users. Keep the rules in step with
 * database/users/config.json: tests/validators/user-schemas.test.js compares
 * them. The client sends `password`; the database stores only its hash.
 *
 * Which person an account links to for its role, and who may register whom,
 * are checked by the service.
 */
export const createUser = z.strictObject({
    username: z
        .string()
        .min(3)
        .max(50)
        .regex(
            /^[a-z0-9._-]+$/,
            'Only lowercase Latin letters, digits and "._-".'
        ),
    password: z
        .string()
        .min(8)
        .refine(
            (password) => Buffer.byteLength(password) <= MAX_PASSWORD_BYTES,
            `Must be at most ${MAX_PASSWORD_BYTES} bytes.`
        ),
    role: z.enum(Object.values(ROLES)),
    parentId: z.uuidv7().nullable().optional(),
    educatorId: z.uuidv7().nullable().optional(),
    teacherId: z.uuidv7().nullable().optional(),
});
