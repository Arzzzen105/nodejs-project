import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { FileDatabase } from '../../src/storage/file-database.js';
import { ChangeLog } from '../../src/storage/change-log.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
} from '../helpers/temp-db.js';
import { createTestLogger } from '../helpers/test-logger.js';

const OWNERS = {
    table: 'owners',
    primaryKey: 'id',
    columns: { name: { type: 'string', required: true } },
    indexes: [],
};

describe('change context', () => {
    let root;
    let db;
    let logger;

    const open = async (changeContext) => {
        db = await new FileDatabase(root, { logger, changeContext }).init();
        return db;
    };
    const contexts = async () => {
        const result = [];
        for await (const entry of new ChangeLog(root).entries()) {
            result.push(entry.context);
        }
        return result;
    };

    beforeEach(async () => {
        root = await createTempDir();
        await writeCollectionConfig(root, 'owners', OWNERS);
        logger = createTestLogger();
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await db?.close();
        await removeDir(root);
    });

    test('without a provider the context is null', async () => {
        await open();
        await db.create('owners', { name: 'Ann' });
        expect(await contexts()).toEqual([null]);
    });

    test('what the provider returns at the commit is recorded', async () => {
        // ARRANGE
        let calls = 0;
        await open(() => ({ requestId: `r${++calls}`, userId: null }));

        // ACT
        await db.create('owners', { name: 'Ann' });
        await db.transaction(async (tx) => {
            await tx.create('owners', { name: 'Bob' });
            await tx.create('owners', { name: 'Cid' });
        });

        // ASSERT: asked once per commit
        expect(await contexts()).toEqual([
            { requestId: 'r1', userId: null },
            { requestId: 'r2', userId: null },
        ]);
    });

    test('a copy is recorded: changing the object later changes nothing', async () => {
        // ARRANGE
        const context = { requestId: 'r1', tags: ['a'] };
        await open(() => context);

        // ACT
        await db.create('owners', { name: 'Ann' });
        context.requestId = 'changed';
        context.tags.push('b');

        // ASSERT
        expect(await contexts()).toEqual([{ requestId: 'r1', tags: ['a'] }]);
    });

    test('concurrent transactions each get the context of their own caller', async () => {
        // ARRANGE: like requests, each runs in its own async context
        const request = new AsyncLocalStorage();
        await open(() => request.getStore() ?? null);

        // ACT: the writer queue runs them one at a time
        await Promise.all(
            ['r1', 'r2', 'r3'].map((requestId) =>
                request.run({ requestId }, () =>
                    db.transaction(async (tx) => {
                        await new Promise((resolve) => setTimeout(resolve, 5));
                        await tx.create('owners', { name: requestId });
                    })
                )
            )
        );

        // ASSERT
        const entries = [];
        for await (const entry of new ChangeLog(root).entries()) {
            entries.push(entry);
        }
        for (const entry of entries) {
            expect(entry.context.requestId).toBe(entry.changes[0].after.name);
        }
        expect(entries).toHaveLength(3);
    });

    test('a commit recovered on start keeps the context it was made with', async () => {
        // ARRANGE: the change log line is lost in a crash, the journal stays
        await open(() => ({ requestId: 'original' }));
        const append = vi
            .spyOn(ChangeLog.prototype, 'append')
            .mockRejectedValueOnce(new Error('crash'));
        await db.create('owners', { name: 'Ann' });
        append.mockRestore();
        await db.close();

        // ACT: the next start has another context
        await open(() => ({ requestId: 'startup' }));

        // ASSERT
        expect(await contexts()).toEqual([{ requestId: 'original' }]);
    });

    describe('a bad provider never fails the commit', () => {
        test.each([
            [
                'throws',
                () => {
                    throw new Error('no request');
                },
            ],
            ['returns a string', () => 'r1'],
            ['returns an array', () => ['r1']],
            ['returns a class instance', () => new Date()],
            ['returns something JSON cannot hold', () => ({ big: 1n })],
        ])(
            'when it %s: context null and a warning',
            async (_label, provider) => {
                // ARRANGE
                await open(provider);

                // ACT
                const ann = await db.create('owners', { name: 'Ann' });

                // ASSERT
                await expect(db.get('owners', ann.id)).resolves.toEqual(ann);
                expect(await contexts()).toEqual([null]);
                expect(
                    logger.at('warn').map((entry) => entry.message)
                ).toContain(
                    'Cannot read the change context; the commit is recorded without one'
                );
            }
        );

        test.each([
            ['null', null],
            ['undefined', undefined],
        ])(
            'returning %s means no context, without a warning',
            async (_label, value) => {
                await open(() => value);
                await db.create('owners', { name: 'Ann' });
                expect(await contexts()).toEqual([null]);
                expect(logger.at('warn')).toEqual([]);
            }
        );
    });

    test('a provider that is not a function is rejected at construction', () => {
        expect(
            () => new FileDatabase(root, { changeContext: { requestId: 'r1' } })
        ).toThrow('"changeContext" must be a function.');
    });
});
