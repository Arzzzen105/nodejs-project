import { items, object, page, record } from '../schemas.js';

/**
 * What the reference says about the operations over the records of the
 * kindergarten: accounts, kids, parents, groups, staff, subjects, rooms,
 * discounts. Keys are `METHOD /path` as OpenAPI writes them; roles, path,
 * query and body come from the routes themselves (collect.js).
 *
 * Each entry: `summary`, `description` (markdown), `response` (`schema`,
 * `description`), `status` if not the usual one, `errors` as
 * `[status, code, why]` besides those every operation of its kind has.
 */

/**
 * The six operations of a collection: list, create, read, replace, change,
 * delete.
 * @param {string} base `/api/kids`
 * @param {string} collection `kids`
 * @param {object} words
 * @param {string} words.one `a kid`
 * @param {string} words.many `kids`
 * @param {string} [words.rules] Business rules of writes, markdown
 * @param {Array<[number, string, string]>} [words.writeErrors] Of create,
 *   replace and change
 * @param {string} [words.read] Who sees which records
 * @param {string} [words.deletes] What deleting also does
 * @param {Array<[number, string, string]>} [words.deleteErrors]
 * @param {Record<string, object>} [overrides] By key, merged over the
 *   generated entries
 */
function crud(base, collection, words, overrides = {}) {
    const { one, many, rules, read, deletes } = words;
    const writeErrors = words.writeErrors ?? [];
    const join = (...parts) => parts.filter(Boolean).join('\n\n');
    const entries = {
        [`GET ${base}`]: {
            summary: `List ${many}`,
            description: join(`A page of ${many}, filtered and sorted.`, read),
            response: { schema: page(collection) },
        },
        [`POST ${base}`]: {
            summary: `Create ${one}`,
            description: join(rules),
            response: {
                description: `Created; \`Location\` points to it.`,
                schema: record(collection),
            },
            errors: writeErrors,
        },
        [`GET ${base}/{id}`]: {
            summary: `Read ${one}`,
            description: join(read),
            response: { schema: record(collection) },
        },
        [`PUT ${base}/{id}`]: {
            summary: `Replace ${one}`,
            description: join(
                'Every field is sent; one left out takes its default.',
                rules
            ),
            response: { schema: record(collection) },
            errors: writeErrors,
        },
        [`PATCH ${base}/{id}`]: {
            summary: `Change ${one}`,
            description: join('Only the fields sent change.', rules),
            response: { schema: record(collection) },
            errors: writeErrors,
        },
        [`DELETE ${base}/{id}`]: {
            summary: `Delete ${one}`,
            description: join(deletes),
            response: { description: 'Deleted.' },
            errors: words.deleteErrors ?? [],
        },
    };
    for (const [key, entry] of Object.entries(overrides)) {
        entries[key] = { ...entries[key], ...entry };
    }
    return entries;
}

const GROUP_RULES = [
    [409, 'GROUP_FULL', 'The group already has 20 kids (BR-03).'],
    [
        409,
        'GROUP_NOT_READY',
        'The group has no room, educator or assistant yet (BR-08).',
    ],
    [422, 'GROUP_AGE_MISMATCH', 'The group is of another age (BR-02).'],
];

export const ENTITIES = {
    'POST /api/auth/login': {
        summary: 'Log in',
        description:
            'Answers a token for `Authorization: Bearer <token>`, valid for `TOKEN_TTL` (8 hours by default). Logins and passwords are set at registration and never change (BR-66–BR-68).',
        status: 200,
        response: {
            schema: object({
                token: { type: 'string' },
                user: record('users'),
            }),
        },
        errors: [
            [
                401,
                'INVALID_CREDENTIALS',
                'Wrong username or password; which of them is not told.',
            ],
        ],
    },
    'GET /api/auth/me': {
        summary: 'Who am I',
        description:
            'The account of the token, with the person it links to (`parentId`, `educatorId`, `teacherId`).',
        response: { schema: record('users') },
    },

    'GET /api/users': {
        summary: 'List accounts',
        description: 'Accounts hold only login data; contacts stay on people.',
        response: { schema: page('users') },
    },
    'POST /api/users': {
        summary: 'Register an account',
        description:
            'The registrar sets the username and the password (BR-66). An account of an educator, a teacher or a parent links to that person (`educatorId`, `teacherId`, `parentId`); those of the admin and the manager link to no one. The manager registers anyone but an admin or a manager (BR-64, BR-65). The password is stored as a hash and never returned.',
        response: {
            description: 'Registered; `Location` points to it.',
            schema: record('users'),
        },
        errors: [
            [
                403,
                'FORBIDDEN',
                'A manager registering an admin or a manager (BR-65).',
            ],
            [409, 'UNIQUE_VIOLATION', 'The username, or the person, is taken.'],
            [
                422,
                'USER_PERSON_MISMATCH',
                'The account links to no one, or to someone of another role.',
            ],
        ],
    },
    'GET /api/users/{id}': {
        summary: 'Read an account',
        response: { schema: record('users') },
    },
    'DELETE /api/users/{id}': {
        summary: 'Delete an account',
        description:
            'There is no change of an account: logins and passwords do not change (BR-67). The manager deletes any but those of the admin and the manager.',
        response: { description: 'Deleted.' },
        errors: [
            [
                403,
                'FORBIDDEN',
                'A manager deleting an account of an admin or a manager.',
            ],
            [
                409,
                'CANNOT_DELETE_SELF',
                'Nobody deletes their own account, so the last admin stays.',
            ],
        ],
    },

    ...crud(
        '/api/kids',
        'kids',
        {
            one: 'a kid',
            many: 'kids',
            read: 'An educator sees the kids of their group; a parent, their own kids.',
            rules: [
                'Rules (FR-001):',
                '- a kid joins only a group of their age (BR-02) that has a room, an educator and an assistant (BR-08) and fewer than 20 kids (BR-03); a later change of age keeps them in it (BR-10);',
                '- the mother is FEMALE, the father MALE (BR-12);',
                '- only the admin sets the discount (BR-26) and the payment plan (FR-013).',
            ].join('\n'),
            writeErrors: [
                ...GROUP_RULES,
                [
                    403,
                    'FORBIDDEN',
                    'A manager setting the discount or the payment plan (BR-26).',
                ],
                [422, 'MOTHER_NOT_FEMALE', 'The mother is not FEMALE (BR-12).'],
                [422, 'FATHER_NOT_MALE', 'The father is not MALE (BR-12).'],
            ],
            deletes:
                'In one transaction (FR-018): the notes of the kid, each parent with no kids left (and their account), and the group if it has no kids left. Educators and assistants stay.',
        },
        {
            'GET /api/kids/{id}': {
                summary: 'Read a kid',
                description:
                    'An educator reads the kids of their group; a parent, their own (403 for others).',
            },
        }
    ),

    ...crud('/api/kids/{kidId}/notes', 'notes', {
        one: 'a note about the kid',
        many: 'notes about the kid',
        read: 'An educator reads the notes of the kids of their group; a parent, of their own kids, and writes them (2.6). A note of another kid answers 404.',
    }),

    ...crud(
        '/api/parents',
        'parents',
        {
            one: 'a parent',
            many: 'parents',
            read: 'An educator sees the parents of the kids of their group; a parent, themselves.',
            rules: 'The sex of a parent who is already the mother or the father of a kid does not change (BR-12).',
            writeErrors: [
                [
                    409,
                    'PARENT_SEX_LOCKED',
                    'They are the mother or the father of a kid (BR-12).',
                ],
            ],
            deletes:
                'Also deletes their account; their kids stay, without this parent.',
        },
        {
            'POST /api/parents': { errors: [] },
        }
    ),
    'GET /api/parents/{id}/kids': {
        summary: 'Kids of a parent',
        description: 'As the mother or as the father.',
        response: { schema: page('kids') },
    },

    ...crud(
        '/api/groups',
        'groups',
        {
            one: 'a group',
            many: 'groups',
            read: 'An educator sees their group; a parent, the groups of their kids; a teacher, the groups they teach in the published timetable. `attendsSpeechLessons` is derived: a kid of the group needs speech lessons (FR-021).',
            rules: 'The name is unique (BR-07); an educator and an assistant have one group at most (BR-04, BR-05); there are 15 groups at most (BR-19). Its room is assigned on the room (`PATCH /api/rooms/{id}`).',
            writeErrors: [
                [409, 'GROUP_LIMIT_REACHED', 'There are 15 groups (BR-19).'],
                [
                    409,
                    'UNIQUE_VIOLATION',
                    'The name, the educator or the assistant is taken.',
                ],
            ],
            deletes:
                'Its kids stay without a group, its educator and assistant without a group, its room free (FR-018).',
        },
        {
            'GET /api/groups': {
                query: {
                    attendsSpeechLessons:
                        'Only the groups that do (`true`) or do not (`false`) attend speech lessons (FR-021).',
                },
            },
            'PUT /api/groups/{id}': {
                errors: [
                    [
                        409,
                        'UNIQUE_VIOLATION',
                        'The name, the educator or the assistant is taken.',
                    ],
                ],
            },
            'PATCH /api/groups/{id}': {
                errors: [
                    [
                        409,
                        'UNIQUE_VIOLATION',
                        'The name, the educator or the assistant is taken.',
                    ],
                ],
            },
        }
    ),
    'GET /api/groups/{id}/kids': {
        summary: 'Kids of a group',
        description:
            'A parent sees only `id`, `firstName`, `lastName` of the kids (2.6); a teacher also `sex` and `age` (2.4), and both filter and sort only by those.',
        response: { schema: page('kids') },
        errors: [
            [
                403,
                'FORBIDDEN',
                'Not their group, or a filter on a field they do not see.',
            ],
        ],
    },
    'POST /api/groups/{id}/kids': {
        summary: 'Add kids to a group at once',
        description:
            'FR-020: every kid moves, or none: the rules of a kid joining a group apply to each.',
        status: 200,
        response: { schema: items('kids') },
        errors: [
            ...GROUP_RULES,
            [
                422,
                'KIDS_CANNOT_JOIN',
                'Some of the kids cannot join; `details` says which and why.',
            ],
        ],
    },
    'GET /api/groups/{id}/room': {
        summary: 'Room of a group',
        description: 'Answers 404 if the group has no room yet.',
        response: { schema: record('rooms') },
    },

    ...crud('/api/educators', 'educators', {
        one: 'an educator',
        many: 'educators',
        read: 'An educator reads their own record.',
        deletes: 'Also deletes their account; their group stays without them.',
    }),
    'GET /api/educators/{id}/group': {
        summary: 'Group of an educator',
        description: 'Answers 404 if they have no group.',
        response: { schema: record('groups') },
    },

    ...crud('/api/assistants', 'assistants', {
        one: 'an assistant',
        many: 'assistants',
        deletes: 'Their group stays without them.',
    }),
    'GET /api/assistants/{id}/group': {
        summary: 'Group of an assistant',
        description: 'Answers 404 if they have no group.',
        response: { schema: record('groups') },
    },

    ...crud('/api/teachers', 'teachers', {
        one: 'a teacher',
        many: 'teachers',
        read: 'A teacher reads their own record.',
        rules: '`subjectIds`: the subjects they teach.',
        deletes:
            'Also deletes their account; their lessons in a timetable stay without a teacher (BR-53).',
    }),

    ...crud('/api/subjects', 'subjects', {
        one: 'a subject',
        many: 'subjects',
        rules: '`lessonsPerWeekAge2`…`lessonsPerWeekAge5`: lessons a week for groups of each age, 2 by default (BR-54, BR-60). `speechLessons`: lessons of the speech therapist, only for groups that attend them (FR-021).',
        deletes:
            'Teachers and rooms lose it; its lessons in a timetable stay without a subject (BR-53).',
    }),
    'GET /api/subjects/{id}/teachers': {
        summary: 'Teachers of a subject',
        response: { schema: page('teachers') },
    },
    'GET /api/subjects/{id}/rooms': {
        summary: 'Rooms for a subject',
        response: { schema: page('rooms') },
    },

    ...crud('/api/rooms', 'rooms', {
        one: 'a room',
        many: 'rooms',
        rules: 'A room is for a group (`groupId`) or for classes of its subjects (`subjectIds`), not both (BR-14, BR-15); the gym hosts two subjects (BR-18). There are 20 rooms at most (BR-13).',
        writeErrors: [
            [409, 'ROOM_LIMIT_REACHED', 'There are 20 rooms (BR-13).'],
            [
                409,
                'UNIQUE_VIOLATION',
                'The name is taken, or the group has a room.',
            ],
            [
                422,
                'ROOM_PURPOSE_CONFLICT',
                'Both a group and subjects (BR-14, BR-15).',
            ],
        ],
    }),

    ...crud(
        '/api/discounts',
        'discounts',
        {
            one: 'a discount',
            many: 'discounts',
            rules: '`rate` is a share of the tuition, 0–1 (0.1 is 10%, BR-25). Discounts apply to the tuition only (BR-30). Only the admin manages them (BR-26).',
            read: 'A parent reads the discounts of their kids (2.6).',
            deletes: 'Kids with it are left without a discount.',
        },
        {
            'GET /api/discounts': { description: 'A page of discounts.' },
        }
    ),
    'GET /api/discounts/{id}/kids': {
        summary: 'Kids with a discount',
        response: { schema: page('kids') },
    },
};
