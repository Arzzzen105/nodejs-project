import { z } from 'zod';

/**
 * Body of POST /api/auth/login. Only the shape is checked: a username or a
 * password that breaks the rules of registration simply does not match any
 * account, and is answered 401 like any other wrong one.
 */
export const login = z.strictObject({
    username: z.string().min(1).max(100),
    password: z.string().min(1).max(200),
});
