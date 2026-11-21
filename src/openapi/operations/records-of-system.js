import { object } from '../schemas.js';

/**
 * What the reference says about the records of the system itself: the
 * history of changes (FR-15) and the diagnostics (FR-019). See entities.js
 * for the form of an entry.
 */

const change = object({
    tx: {
        type: 'string',
        format: 'uuid',
        description:
            'The transaction; changes by the rules of onDelete share the one of the delete',
    },
    at: { type: 'string', format: 'date-time' },
    collection: { type: 'string' },
    id: { type: 'string', format: 'uuid' },
    op: { type: 'string', enum: ['create', 'update', 'delete'] },
    changedFields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Fields that differ, but the id and the timestamps',
    },
    before: {
        type: ['object', 'null'],
        description: 'The whole record before; null for create',
    },
    after: {
        type: ['object', 'null'],
        description: 'The whole record after; null for delete',
    },
    userId: { type: ['string', 'null'], format: 'uuid' },
    user: {
        anyOf: [
            object({
                id: { type: 'string', format: 'uuid' },
                username: { type: 'string' },
                role: { type: 'string' },
            }),
            { type: 'null' },
        ],
        description:
            'The account that made the change, as it is now; null for a change of the system, or a deleted account',
    },
    requestId: { type: ['string', 'null'] },
});

const problemPage = (entity, codes) => ({
    summary: `${entity[0].toUpperCase()}${entity.slice(1)} with problems`,
    description: `Records of ${entity} that break a rule, each with its \`problems\`: ${codes.map((c) => `\`${c}\``).join(', ')}.`,
    query: { problem: 'Only the records with this problem.' },
    response: {
        schema: object({
            items: {
                type: 'array',
                items: {
                    type: 'object',
                    description: `A record of ${entity}, with its problems`,
                    required: ['id', 'problems'],
                    properties: {
                        id: { type: 'string', format: 'uuid' },
                        problems: { type: 'array', items: { type: 'string' } },
                    },
                },
            },
            total: { type: 'integer' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
        }),
    },
});

export const SYSTEM = {
    'GET /api/changes': {
        summary: 'History of changes',
        description:
            'Every change of every record (FR-15), newest first: who made it, when, how, and the record before and after. Filters narrow it to a record, a collection, an account, an operation or a time. The history holds whole records with personal data, so it is for the admin only; hashes of passwords are left out.',
        query: {
            collection: 'Of one collection, e.g. `kids`.',
            id: 'Of one record.',
            userId: 'Made by one account.',
            op: '`create`, `update` or `delete`.',
            from: 'At or after, ISO 8601 with an offset.',
            to: 'Before, ISO 8601 with an offset.',
            limit: 'Items on a page: 50 by default, at most 500.',
        },
        response: {
            schema: object({
                items: { type: 'array', items: change },
                total: { type: 'integer' },
                limit: { type: 'integer' },
                offset: { type: 'integer' },
            }),
        },
    },
    'GET /api/consistency': {
        summary: 'Diagnostics',
        description:
            'Records that break the rules of the kindergarten (FR-019), e.g. kids without a group, groups without an educator. Writes allow these states on purpose: rules are checked on the side that joins, and what breaks later through a change elsewhere is found here. Each problem with how many records have it and where to list them; empty when all is well.',
        response: {
            schema: object({
                problems: {
                    type: 'array',
                    items: object({
                        code: { type: 'string' },
                        entity: {
                            type: 'string',
                            enum: ['kids', 'groups', 'educators', 'assistants'],
                        },
                        count: { type: 'integer' },
                        href: { type: 'string' },
                    }),
                },
            }),
        },
    },
    'GET /api/consistency/kids': problemPage('kids', [
        'KID_WITHOUT_GROUP',
        'KID_INCOMPLETE_PARENTS',
        'KID_GROUP_AGE_MISMATCH',
    ]),
    'GET /api/consistency/groups': problemPage('groups', [
        'GROUP_WITHOUT_EDUCATOR',
        'GROUP_WITHOUT_ASSISTANT',
        'GROUP_WITHOUT_ROOM',
        'GROUP_NOT_READY_WITH_KIDS',
    ]),
    'GET /api/consistency/educators': problemPage('educators', [
        'EDUCATOR_WITHOUT_GROUP',
    ]),
    'GET /api/consistency/assistants': problemPage('assistants', [
        'ASSISTANT_WITHOUT_GROUP',
    ]),
};
