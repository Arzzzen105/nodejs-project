import { z } from 'zod';

/**
 * Body of POST and PUT /api/subjects. Keep the rules in step with
 * database/subjects/config.json: tests/validators/subject-schemas.test.js compares them.
 *
 * No `.default()` here: `.partial()` would keep it, and PATCH would overwrite
 * the field. Defaults are filled in by the database.
 */
const lessonsPerWeek = z.int().min(0).max(10).optional();

export const createSubject = z.strictObject({
    name: z.string().min(1).max(30),
    // lessons a week for a group of each age (BR-54, BR-55, BR-60); at most
    // 10, two a day, as a subject never comes twice in a row (BR-61)
    lessonsPerWeekAge2: lessonsPerWeek,
    lessonsPerWeekAge3: lessonsPerWeek,
    lessonsPerWeekAge4: lessonsPerWeek,
    lessonsPerWeekAge5: lessonsPerWeek,
    // lessons of the speech therapist: only for the groups that need them
    // (FR-021)
    speechLessons: z.boolean().optional(),
});

/**
 * Body of PATCH /api/subjects/:id: the same fields, each of them optional.
 */
export const updateSubject = createSubject.partial();
