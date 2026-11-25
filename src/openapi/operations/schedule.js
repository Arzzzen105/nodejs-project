import { object, page, record } from '../schemas.js';

/**
 * What the reference says about the timetable (EPIC-05). See entities.js
 * for the form of an entry.
 */

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

const time = { type: 'string', description: '`HH:MM`', example: '09:30' };

/** An event as stored, with its times. */
const entry = {
    allOf: [record('schedule_entries'), object({ start: time, end: time })],
};

/** A timetable with its events. */
const withEntries = {
    allOf: [
        record('schedules'),
        object({ entries: { type: 'array', items: entry } }),
    ],
};

const named = (properties) => ({
    anyOf: [
        object({ id: { type: 'string', format: 'uuid' }, ...properties }),
        { type: 'null' },
    ],
});

/** An event of a week, with the names of what it involves. */
const event = object({
    id: { type: 'string', format: 'uuid' },
    start: time,
    end: time,
    kind: { type: 'string', enum: ['LESSON', 'MEAL', 'SLEEP'] },
    meal: {
        type: ['string', 'null'],
        enum: ['BREAKFAST', 'LUNCH', 'SNACK', null],
    },
    group: named({ name: { type: 'string' } }),
    subject: named({ name: { type: 'string' } }),
    teacher: named({
        firstName: { type: 'string' },
        lastName: { type: 'string' },
    }),
    room: named({ name: { type: 'string' } }),
});

const week = object({
    scheduleId: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'null when nothing is published yet',
    },
    publishedAt: { type: ['string', 'null'], format: 'date-time' },
    days: object(
        Object.fromEntries(
            DAYS.map((day) => [day, { type: 'array', items: event }])
        ),
        'The events of each day, in order of time.'
    ),
});

const WEEK =
    'The published timetable, by day: every day 09:00–17:00 in slots of 15 minutes (BR-42). An empty week while nothing is published.';

export const SCHEDULE = {
    'GET /api/schedules': {
        summary: 'List timetables',
        description:
            'At most one DRAFT and one PUBLISHED; the earlier published ones are ARCHIVED. Without their events.',
        response: { schema: page('schedules') },
    },
    'POST /api/schedules': {
        summary: 'Generate a draft',
        description:
            'Generates the week of every group from the records as they are now (FR-006–FR-008, FR-021): lessons by the load of each subject for the age of the group, meals and sleep in their windows, a teacher of the subject and a room for it, no subject twice in a row. It replaces the previous draft. Lessons that find no place are in `unplaced`; such a draft cannot be published. The timetable is never generated on its own (BR-53).',
        response: {
            description: 'The draft; `Location` points to it.',
            schema: {
                allOf: [
                    record('schedules'),
                    object({
                        placed: {
                            type: 'integer',
                            description: 'Events placed',
                        },
                    }),
                ],
            },
        },
    },
    'GET /api/schedules/draft': {
        summary: 'The current draft',
        description: 'With its events. A teacher gets only their own lessons.',
        response: { schema: withEntries },
        errors: [[404, 'NOT_FOUND', 'There is no draft: generate one.']],
    },
    'GET /api/schedules/published': {
        summary: 'The published timetable',
        description: 'With its events. A teacher gets only their own lessons.',
        response: { schema: withEntries },
        errors: [[404, 'NOT_FOUND', 'Nothing is published yet.']],
    },
    'GET /api/schedules/{id}': {
        summary: 'Read a timetable',
        description: 'With its events. A teacher gets only their own lessons.',
        response: { schema: withEntries },
    },
    'PATCH /api/schedules/{id}/entries/{entryId}': {
        summary: 'Move an event of a draft',
        description:
            'Another day, slot, room or teacher. The change is refused only for a conflict it makes itself (FR-006): one the draft had before stays. A teacher moves only their own lessons, and keeps them (2.4).',
        response: { description: 'The event after the change.', schema: entry },
        errors: [
            [
                403,
                'FORBIDDEN',
                'A teacher moving a lesson of another, or giving theirs away.',
            ],
            [409, 'SCHEDULE_NOT_DRAFT', 'Only a draft changes.'],
            [
                409,
                'SCHEDULE_CONFLICT',
                'The change breaks a rule; `details` lists each new conflict (rule in `field`).',
            ],
            [
                422,
                'INVALID_CHANGE',
                'A room or a teacher for a meal or a sleep.',
            ],
        ],
    },
    'POST /api/schedules/{id}/publish': {
        summary: 'Publish a draft',
        description:
            'Once it breaks no rule (FR-006): the published timetable before it is archived. Then the groups, teachers and parents see it.',
        status: 200,
        response: { schema: record('schedules') },
        errors: [
            [409, 'SCHEDULE_NOT_DRAFT', 'Only a draft is published.'],
            [
                409,
                'SCHEDULE_INVALID',
                'The draft breaks rules, or has lessons unplaced; `details` lists each.',
            ],
        ],
    },
    'GET /api/groups/{id}/schedule': {
        summary: 'Week of a group',
        description: `${WEEK} The educator sees their group; parents, the groups of their kids.`,
        response: { schema: week },
        errors: [[403, 'FORBIDDEN', 'Not their group.']],
    },
    'GET /api/teachers/{id}/schedule': {
        summary: 'Week of a teacher',
        description: `${WEEK} Every lesson of the teacher, across groups. A teacher sees their own.`,
        response: { schema: week },
        errors: [[403, 'FORBIDDEN', 'Another teacher.']],
    },
    'GET /api/rooms/{id}/schedule': {
        summary: 'When a room is taken',
        description: `${WEEK} The lessons in the room (FR-009).`,
        response: { schema: week },
    },
};
