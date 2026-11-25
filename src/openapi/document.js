import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ROLES } from '../security/roles.js';
import { ITEM_SCHEMAS, recordSchemas } from './records.js';
import { OPERATIONS } from './operations/index.js';

const PACKAGE = JSON.parse(
    fs.readFileSync(
        path.resolve(import.meta.dirname, '..', '..', 'package.json'),
        'utf8'
    )
);

const ALL_ROLES = Object.values(ROLES);

/** Statuses an operation answers with by default, when it succeeds. */
const SUCCESS = { get: 200, post: 201, put: 200, patch: 200, delete: 204 };

const STATUS_TEXT = {
    200: 'OK',
    201: 'Created',
    204: 'No content',
    400: 'Bad request',
    401: 'No valid token',
    403: 'Forbidden',
    404: 'Not found',
    409: 'Conflict',
    422: 'Unprocessable',
};

const INTRODUCTION = `
Server of a kindergarten: kids, parents, groups, staff, the timetable, money.

### Logging in
\`POST /api/auth/login\` with a username and a password answers a token. Every
other request sends it: \`Authorization: Bearer <token>\`. In this page press
**Authorize** and paste the token. Accounts are registered by the admin and
the manager (\`POST /api/users\`).

### Roles
ADMIN (the owner: everything), MANAGER (runs the kindergarten, does not change
money), EDUCATOR (their group), TEACHER (their timetable and groups), PARENT
(their kids). Each operation says which roles may call it; which records are
theirs (a parent's kids) is checked too, and answers 403 for someone else's.

### Lists
Lists answer \`{ items, total, limit, offset }\` and take:
- \`where\`: conditions as JSON: \`{"age":3}\`, \`{"age":{"gte":3,"lt":5}}\`,
  \`{"groupId":{"in":["…","…"]}}\`, \`{"discountId":{"ne":null}}\`;
- \`sort\`: fields, \`-\` for descending: \`lastName,-age\`;
- \`limit\` (default 20, at most 500) and \`offset\`.

### Errors
Every error answers \`{ "error": { "code", "message", "details"? } }\`. \`code\`
is for programs, \`message\` for people; \`details\` lists the wrong fields.
Besides those of each operation:
- 400 \`INVALID_ID\`, \`INVALID_QUERY\`, \`INVALID_JSON\`; 422 \`VALIDATION_ERROR\`:
  the request is malformed;
- 401 \`UNAUTHENTICATED\`: no token, or not a valid one;
- 403 \`FORBIDDEN\`: the role, or the record is not theirs;
- 404 \`NOT_FOUND\`: no such record, or no such route;
- 409 \`UNIQUE_VIOLATION\` (a value that must be unique), \`REFERENCE_RESTRICT\`
  (other records still refer to it); 422 \`REFERENCE_NOT_FOUND\` (an id of a
  record that does not exist);
- 503: the database is busy or recovering; try again.

A refused request changes nothing.
`.trim();

/**
 * The OpenAPI document of the API.
 * @param {import('./collect.js').Operation[]} operations From collectOperations
 * @param {Record<string, object>} [descriptions] What people write about each
 *   operation, by `METHOD /path`; see operations/index.js
 * @returns {object} OpenAPI 3.1
 */
export function buildDocument(operations, descriptions = OPERATIONS) {
    const paths = {};
    const tags = new Set();
    for (const operation of operations) {
        const tag = tagOf(operation.mount);
        tags.add(tag);
        paths[operation.path] ??= {};
        paths[operation.path][operation.method] = describe(
            operation,
            descriptions[keyOf(operation)],
            tag
        );
    }
    return {
        openapi: '3.1.0',
        info: {
            title: 'Kindergarten API',
            version: PACKAGE.version,
            description: INTRODUCTION,
        },
        tags: [...tags].map((name) => ({ name })),
        paths,
        components: {
            securitySchemes: {
                bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            },
            schemas: {
                Error: {
                    type: 'object',
                    required: ['error'],
                    properties: {
                        error: {
                            type: 'object',
                            required: ['code', 'message'],
                            properties: {
                                code: { type: 'string' },
                                message: { type: 'string' },
                                details: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            field: { type: 'string' },
                                            message: { type: 'string' },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                ...recordSchemas(),
                ...ITEM_SCHEMAS,
            },
        },
    };
}

/**
 * @param {import('./collect.js').Operation} operation
 * @returns {string} `GET /api/kids/{id}`: the key of its description
 */
export function keyOf(operation) {
    return `${operation.method.toUpperCase()} ${operation.path}`;
}

/**
 * One operation of the document.
 * @param {import('./collect.js').Operation} operation
 * @param {object} [text] What people wrote about it
 * @param {string} tag
 */
function describe(operation, text = {}, tag) {
    const { params, query, body } = operation.schemas;
    const success = text.status ?? SUCCESS[operation.method];
    return {
        tags: [tag],
        summary: text.summary ?? 'Not described yet',
        description: [whoMay(operation), text.description]
            .filter(Boolean)
            .join('\n\n'),
        operationId: operationId(operation),
        'x-roles': operation.roles ?? (operation.open ? [] : ALL_ROLES),
        security: operation.open ? [] : [{ bearer: [] }],
        parameters: [
            ...parameters(params, 'path'),
            ...parameters(query, 'query', text.query),
            ...(text.headers ?? []),
        ],
        ...(body && {
            requestBody: {
                required: true,
                content: { 'application/json': { schema: jsonSchema(body) } },
            },
        }),
        responses: {
            [success]: {
                description: text.response?.description ?? STATUS_TEXT[success],
                ...(text.response?.headers && {
                    headers: text.response.headers,
                }),
                ...(text.response?.schema && {
                    content: {
                        'application/json': { schema: text.response.schema },
                    },
                }),
            },
            ...(text.responses ?? {}),
            ...errors(operation, text.errors ?? []),
        },
    };
}

/** Who may call it, as the first line of its description. */
function whoMay({ open, roles }) {
    if (open) return '**No token needed.**';
    if (!roles) return '**Roles:** any signed-in account.';
    return `**Roles:** ${roles.join(', ')}.`;
}

/**
 * The errors of an operation: those every operation of its kind has, and
 * its own, grouped by status.
 * @param {import('./collect.js').Operation} operation
 * @param {Array<[number, string, string]>} own `[status, code, why]`
 */
function errors(operation, own) {
    const { params, query, body } = operation.schemas;
    const all = [
        ...(params
            ? [[400, 'INVALID_ID', 'An id in the path is not a UUID.']]
            : []),
        ...(query
            ? [[400, 'INVALID_QUERY', 'The query string is invalid.']]
            : []),
        ...(operation.open
            ? []
            : [[401, 'UNAUTHENTICATED', 'No token, or not a valid one.']]),
        ...((operation.roles ?? ALL_ROLES).length < ALL_ROLES.length
            ? [[403, 'FORBIDDEN', 'The role may not call this.']]
            : []),
        ...(params ? [[404, 'NOT_FOUND', 'No such record.']] : []),
        ...(body
            ? [[422, 'VALIDATION_ERROR', 'The body is invalid; see details.']]
            : []),
        ...own,
    ];
    const byStatus = new Map();
    for (const [status, code, why] of all) {
        byStatus.set(status, [...(byStatus.get(status) ?? []), [code, why]]);
    }
    return Object.fromEntries(
        [...byStatus]
            .sort(([a], [b]) => a - b)
            .map(([status, list]) => [
                status,
                {
                    description: list
                        .map(([code, why]) => `\`${code}\`: ${why}`)
                        .join('\n\n'),
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/Error' },
                        },
                    },
                },
            ])
    );
}

/**
 * Parameters of the path or the query string, from the schema `validate`
 * checks them with.
 * @param {import('zod').ZodType} [schema]
 * @param {'path'|'query'} place
 * @param {Record<string, string>} [notes] Descriptions of query parameters
 */
function parameters(schema, place, notes = {}) {
    if (!schema) return [];
    const { properties = {}, required = [] } = jsonSchema(schema);
    return Object.entries(properties).map(([name, property]) => ({
        name,
        in: place,
        required: place === 'path' || required.includes(name),
        ...((notes[name] ?? COMMON_QUERY[name]) && {
            description: notes[name] ?? COMMON_QUERY[name],
        }),
        schema: property,
    }));
}

/** What the parameters of every list mean. */
const COMMON_QUERY = {
    where: 'Conditions as JSON, e.g. `{"age":{"gte":3}}`.',
    sort: 'Fields to sort by, `-` for descending, e.g. `lastName,-age`.',
    limit: 'Items on a page: 20 by default, at most 500.',
    offset: 'Items to skip.',
};

/**
 * @param {import('zod').ZodType} schema
 * @returns {object} JSON Schema of what a client sends
 */
function jsonSchema(schema) {
    const result = z.toJSONSchema(schema, {
        io: 'input',
        unrepresentable: 'any',
    });
    delete result.$schema;
    return withoutUuidPatterns(result);
}

/**
 * Drops the regular expression Zod writes next to `format: uuid`: the format
 * says the same, and the expression only clutters the page.
 * @param {*} schema
 */
function withoutUuidPatterns(schema) {
    if (Array.isArray(schema)) return schema.map(withoutUuidPatterns);
    if (!schema || typeof schema !== 'object') return schema;
    const copy = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === 'pattern' && schema.format === 'uuid') continue;
        copy[key] = withoutUuidPatterns(value);
    }
    return copy;
}

/** `/api/kids/:kidId/notes` → `Notes`: the last fixed part of the path. */
function tagOf(mount) {
    const name = mount
        .split('/')
        .filter((part) => part && !part.startsWith(':'))
        .at(-1);
    return name[0].toUpperCase() + name.slice(1);
}

/** `GET /api/kids/{id}/price` → `getKidsIdPrice`. */
function operationId({ method, path: route }) {
    return (
        method +
        route
            .replace(/^\/api/, '')
            .split('/')
            .filter(Boolean)
            .map((part) => part.replace(/[{}]/g, ''))
            .map((part) => part[0].toUpperCase() + part.slice(1))
            .join('')
    );
}
