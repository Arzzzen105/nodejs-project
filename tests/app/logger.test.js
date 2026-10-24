import { describe, test, expect } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, requestContext } from '../../src/logger.js';

function capture() {
    const lines = [];
    const destination = new Writable({
        write(chunk, _encoding, done) {
            lines.push(...chunk.toString().trim().split('\n').map(JSON.parse));
            done();
        },
    });
    return { lines, logger: createLogger({ level: 'debug', destination }) };
}

describe('application logger', () => {
    test('adds the request id of the current request to every entry', () => {
        // ARRANGE
        const { lines, logger } = capture();

        // ACT
        requestContext.run({ requestId: 'r-1' }, () => {
            logger.child({ module: 'storage' }).info({ ms: 3 }, 'inside');
        });
        logger.info('outside');

        // ASSERT
        expect(lines[0]).toMatchObject({
            requestId: 'r-1',
            module: 'storage',
            ms: 3,
            msg: 'inside',
        });
        expect(lines[1]).not.toHaveProperty('requestId');
    });

    test('regression: fields of one entry never leak into the next one', () => {
        // ARRANGE
        const { lines, logger } = capture();

        // ACT
        requestContext.run({ requestId: 'r-2' }, () => {
            logger.debug({ changes: 1, code: 'VALIDATION_ERROR' }, 'first');
            logger.info('second');
        });

        // ASSERT
        expect(lines[1]).toMatchObject({ requestId: 'r-2', msg: 'second' });
        expect(lines[1]).not.toHaveProperty('changes');
        expect(lines[1]).not.toHaveProperty('code');
    });

    test('redacts credentials in request headers', () => {
        // ARRANGE
        const { lines, logger } = capture();

        // ACT
        logger.info(
            {
                req: {
                    headers: {
                        authorization: 'Bearer secret',
                        cookie: 'sid=1',
                    },
                },
            },
            'request'
        );

        // ASSERT
        expect(JSON.stringify(lines[0])).not.toMatch(/secret|sid=1/);
    });
});
