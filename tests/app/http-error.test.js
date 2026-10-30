import { describe, test, expect } from 'vitest';
import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../../src/http-error.js';

describe('HttpError', () => {
    test('carries the status and code the error handler answers with', () => {
        const error = new HttpError(
            StatusCodes.BAD_REQUEST,
            'INVALID_QUERY',
            '"where" must be valid JSON.'
        );
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
            name: 'HttpError',
            status: 400,
            code: 'INVALID_QUERY',
            message: '"where" must be valid JSON.',
        });
    });

    test('carries what exactly is wrong, when given', () => {
        const details = [{ field: 'age', message: 'Too big.' }];
        const error = new HttpError(
            StatusCodes.UNPROCESSABLE_ENTITY,
            'VALIDATION_ERROR',
            'The request body is invalid.',
            details
        );
        expect(error.details).toBe(details);
    });
});
