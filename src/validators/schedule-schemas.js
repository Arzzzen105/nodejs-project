import { z } from 'zod';

/**
 * Body of POST /api/schedules: nothing. The draft is generated from the
 * records as they are now.
 */
export const generateSchedule = z.strictObject({}).optional();

/**
 * Path of /api/schedules/:id/entries/:entryId.
 */
export const entryParams = z.object({ id: z.uuidv7(), entryId: z.uuidv7() });

/**
 * Body of PATCH /api/schedules/:id/entries/:entryId: where the event moves.
 * Its group, kind and subject stay: changing them makes another event.
 * Conflicts are checked by the service.
 */
export const moveEntry = z
    .strictObject({
        day: z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI']).optional(),
        // slots of 15 minutes from 09:00 (0) to 16:45 (31)
        slot: z.int().min(0).max(31).optional(),
        teacherId: z.uuidv7().optional(),
        roomId: z.uuidv7().optional(),
    })
    .refine((body) => Object.keys(body).length > 0, 'Nothing to change.');
