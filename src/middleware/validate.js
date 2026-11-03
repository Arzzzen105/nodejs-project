import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';

/**
 * What is checked, in this order, and how each part answers when it is wrong.
 * The first wrong part ends the request.
 */
const PARTS = [
    {
        part: 'params',
        status: StatusCodes.BAD_REQUEST,
        code: 'INVALID_ID',
        message: '"id" must be a UUID.',
    },
    {
        part: 'query',
        status: StatusCodes.BAD_REQUEST,
        code: 'INVALID_QUERY',
        message: 'The query string is invalid.',
    },
    {
        part: 'body',
        status: StatusCodes.UNPROCESSABLE_ENTITY,
        code: 'VALIDATION_ERROR',
        message: 'The request body is invalid.',
    },
];

/**
 * Turns issues of Zod into the `details` of a response.
 * @param {import('zod').ZodError} error
 * @returns {Array<{ field: string, message: string }>}
 */
function toDetails(error) {
    return error.issues.flatMap((issue) =>
        issue.code === 'unrecognized_keys'
            ? issue.keys.map((field) => ({
                  field,
                  message: 'Unknown field.',
              }))
            : [{ field: issue.path.join('.'), message: issue.message }]
    );
}

/**
 * Middleware that checks parts of a request before the controller runs. What
 * passed is in `request.validated`: `request.query` cannot be overwritten in
 * Express 5.
 * @param {{ params?: import('zod').ZodType, query?: import('zod').ZodType, body?: import('zod').ZodType }} schemas
 * @returns {import('express').RequestHandler}
 * @throws {HttpError} 400 INVALID_ID or INVALID_QUERY, 422 VALIDATION_ERROR
 * @example
 * router.patch('/:id', validate({ params: idParams, body: updateKid }), controller.update);
 */
export function validate(schemas) {
    return (request, response, next) => {
        request.validated = {};
        for (const { part, status, code, message } of PARTS) {
            if (!schemas[part]) continue;
            const result = schemas[part].safeParse(request[part]);
            if (!result.success) {
                throw new HttpError(
                    status,
                    code,
                    message,
                    toDetails(result.error)
                );
            }
            request.validated[part] = result.data;
        }
        next();
    };
}
