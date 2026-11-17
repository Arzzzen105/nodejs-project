import { z } from 'zod';
import { PROBLEMS } from '../services/consistency-service.js';

/**
 * Query string of GET /api/consistency/<entity>: a problem of that entity and
 * paging. The records are diagnosed in memory, so the range of `limit` and
 * `offset` is checked here, the same as the database checks it for lists.
 * @param {keyof PROBLEMS} entity
 * @returns {import('zod').ZodType}
 */
export function consistencyQuery(entity) {
    return z.strictObject({
        problem: z.enum(PROBLEMS[entity]).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
    });
}
