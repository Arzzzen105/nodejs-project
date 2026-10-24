import { Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';

/**
 * Turns query string parameters of GET /api/:collection into list options.
 * @param {object} query Parsed query string, e.g. { where: '{"age":3}', sort: 'lastName', limit: '20' }
 * @returns {{ where: object, sort: string|string[]|undefined, limit: number, offset: number }}
 * @throws {HttpError} 400 INVALID_QUERY if "where" is not a JSON object
 */
function parseListQuery(query) {
    let where = {};
    if (query.where !== undefined) {
        if (typeof query.where !== 'string') {
            throw new HttpError(
                StatusCodes.BAD_REQUEST,
                'INVALID_QUERY',
                '"where" must be a JSON object.'
            );
        }
        try {
            where = JSON.parse(query.where);
        } catch {
            throw new HttpError(
                StatusCodes.BAD_REQUEST,
                'INVALID_QUERY',
                '"where" must be valid JSON.'
            );
        }
    }
    return {
        where,
        // "?sort=lastName,-age" or "?sort=lastName&sort=-age"
        sort: query.sort,
        limit: query.limit === undefined ? 100 : Number(query.limit),
        offset: query.offset === undefined ? 0 : Number(query.offset),
    };
}

/**
 * Generic REST routes over every collection of the database:
 * GET /, GET|POST /:collection, GET|PUT|PATCH|DELETE /:collection/:id.
 * @param {import('../storage/file-database.js').FileDatabase} database
 * @returns {import('express').Router}
 */
export function createResourceRouter(database) {
    const router = Router();

    router.get('/', (request, response) => {
        response.json({ collections: database.collections() });
    });

    router.get('/:collection', async (request, response) => {
        response.json(
            await database.list(
                request.params.collection,
                parseListQuery(request.query)
            )
        );
    });

    router.post('/:collection', async (request, response) => {
        const record = await database.create(
            request.params.collection,
            request.body
        );
        response
            .location(`/api/${request.params.collection}/${record.id}`)
            .status(StatusCodes.CREATED)
            .json(record);
    });

    router.get('/:collection/:id', async (request, response) => {
        response.json(
            await database.get(request.params.collection, request.params.id)
        );
    });

    router.put('/:collection/:id', async (request, response) => {
        response.json(
            await database.update(
                request.params.collection,
                request.params.id,
                request.body,
                { replace: true }
            )
        );
    });

    router.patch('/:collection/:id', async (request, response) => {
        response.json(
            await database.update(
                request.params.collection,
                request.params.id,
                request.body
            )
        );
    });

    router.delete('/:collection/:id', async (request, response) => {
        await database.delete(request.params.collection, request.params.id);
        response.status(StatusCodes.NO_CONTENT).end();
    });

    return router;
}
