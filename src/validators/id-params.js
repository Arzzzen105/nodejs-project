import { z } from 'zod';

/**
 * Path of routes with `:id`. Every record has a UUIDv7 id.
 */
export const idParams = z.object({ id: z.uuidv7() });
