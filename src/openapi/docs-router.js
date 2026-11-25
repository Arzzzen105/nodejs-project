import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { collectOperations } from './collect.js';
import { buildDocument } from './document.js';

/**
 * The API reference (NFR-08): GET /api/openapi.json, the OpenAPI document,
 * and /api/docs, the same in Swagger UI, where requests can be tried. Both
 * open: they hold no data. The document is built from the routers on the
 * first request, so starting the application costs nothing.
 * @param {import('../routes/api-routers.js').ApiRouter[]} routers
 * @returns {import('express').Router} To mount at /api
 */
export function createDocsRouter(routers) {
    const router = Router();
    let document;

    router.get('/openapi.json', (request, response) => {
        document ??= buildDocument(collectOperations(routers));
        response.json(document);
    });
    router.use(
        '/docs',
        swaggerUi.serve,
        swaggerUi.setup(null, {
            customSiteTitle: 'Kindergarten API',
            swaggerOptions: {
                url: '/api/openapi.json',
                // the token stays after a reload of the page
                persistAuthorization: true,
            },
        })
    );

    return router;
}
