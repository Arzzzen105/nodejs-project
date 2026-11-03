/**
 * Error of the HTTP layer (routes, services) with a status to answer with.
 * The error handler in app.js reads `status` and `code` the same way it does
 * for errors of the storage engine.
 *
 * @example
 * import { StatusCodes } from 'http-status-codes';
 * throw new HttpError(StatusCodes.BAD_REQUEST, 'INVALID_QUERY', '"where" must be valid JSON.');
 */
export class HttpError extends Error {
    /**
     * @param {number} status HTTP status, e.g. StatusCodes.BAD_REQUEST
     * @param {string} code Machine-readable code
     * @param {string} message Human-readable description
     * @param {Array<{ field: string, message: string }>} [details] What exactly
     *   is wrong, e.g. every invalid field of a request body
     */
    constructor(status, code, message, details) {
        super(message);
        this.name = 'HttpError';
        /** @type {number} */
        this.status = status;
        /** @type {string} */
        this.code = code;
        /** @type {Array<{ field: string, message: string }>|undefined} */
        this.details = details;
    }
}
