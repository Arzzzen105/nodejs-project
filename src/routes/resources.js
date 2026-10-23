import { Router } from 'express';
import { DatabaseError } from '../storage/file-database.js';

function parseListQuery(query) {
    let where = {};
    if (query.where !== undefined) {
        if (typeof query.where !== 'string') {
            throw new DatabaseError(
                '"where" must be a JSON object.',
                400,
                'INVALID_QUERY'
            );
        }
        try {
            where = JSON.parse(query.where);
        } catch {
            throw new DatabaseError(
                '"where" must be valid JSON.',
                400,
                'INVALID_QUERY'
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
            .status(201)
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
        response.status(204).end();
    });

    return router;
}
