import { z } from 'zod';

/**
 * Query string of GET /api/changes (FR-15): filters of the history, all of
 * them optional, and a page. The collection is checked by the service.
 */
export const changesQuery = z.strictObject({
    collection: z.string().min(1).optional(),
    id: z.uuidv7().optional(),
    userId: z.uuidv7().optional(),
    op: z.enum(['create', 'update', 'delete']).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
});
