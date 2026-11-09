import { z } from 'zod';

/**
 * Path of /api/kids/:kidId/notes.
 */
export const kidParams = z.object({ kidId: z.uuidv7() });

/**
 * Path of /api/kids/:kidId/notes/:id.
 */
export const noteParams = z.object({ kidId: z.uuidv7(), id: z.uuidv7() });

/**
 * Body of POST and PUT /api/kids/:kidId/notes. Keep the rules in step with
 * database/notes/config.json: tests/validators/note-schemas.test.js compares them.
 *
 * `kidId` is not in the body: it is taken from the path, so a note cannot be
 * moved to another kid.
 */
export const createNote = z.strictObject({
    text: z.string().min(1).max(200),
});

/**
 * Body of PATCH /api/kids/:kidId/notes/:id: the same fields, each of them optional.
 */
export const updateNote = createNote.partial();
