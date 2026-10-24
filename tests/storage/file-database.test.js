import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { v7 as uuidv7 } from 'uuid';
import {
    FileDatabase,
    DatabaseError,
    eq,
} from '../../src/storage/file-database.js';
import {
    TEST_COLLECTION,
    createTestConfig,
    createTempDir,
    removeDir,
    writeCollectionConfig,
} from '../helpers/temp-db.js';
import { createTestLogger } from '../helpers/test-logger.js';

describe('FileDatabase', () => {
    let root;

    beforeEach(async () => {
        root = await createTempDir();
    });

    afterEach(async () => {
        await removeDir(root);
    });

    async function openDatabase() {
        const db = new FileDatabase(root);
        await db.init();
        return db;
    }

    describe('init', () => {
        test('after initialization engine has valid collection and its schema', async () => {
            // ARRANGE
            await writeCollectionConfig(
                root,
                TEST_COLLECTION,
                createTestConfig()
            );

            // ACT
            const db = await openDatabase();

            // ASSERT
            expect(db.collections()).toEqual([TEST_COLLECTION]);
            expect(db.schema(TEST_COLLECTION)).toEqual(createTestConfig());
        });

        test('schema() returns the config exactly as written', async () => {
            // ARRANGE
            const config = createTestConfig();
            config.columns.code = { type: 'string', pattern: '^[A-Z]{3}$' };
            await writeCollectionConfig(root, TEST_COLLECTION, config);

            // ACT
            const db = await openDatabase();

            // ASSERT
            expect(db.schema(TEST_COLLECTION)).toEqual(config);
            await expect(
                db.create(TEST_COLLECTION, { title: 'x', code: 'abc' })
            ).rejects.toThrow('"code" has an invalid format.');
        });

        test('returns the database instance', async () => {
            // ARRANGE
            const db = new FileDatabase(root);

            // ACT & ASSERT
            await expect(db.init()).resolves.toBe(db);
        });

        test('creates the root directory when it does not exist', async () => {
            // ARRANGE
            const nested = path.join(root, 'nested', 'db');

            // ACT
            const db = new FileDatabase(nested);
            await db.init();

            // ASSERT
            expect(db.collections()).toEqual([]);
            await expect(fs.stat(nested)).resolves.toBeTruthy();
        });

        test('loads several collections', async () => {
            // ARRANGE
            await writeCollectionConfig(
                root,
                TEST_COLLECTION,
                createTestConfig()
            );
            await writeCollectionConfig(root, 'other', {
                ...createTestConfig(),
                table: 'other',
            });

            // ACT
            const db = await openDatabase();

            // ASSERT
            expect(db.collections().sort()).toEqual(['other', TEST_COLLECTION]);
        });

        test('skips directories without config, files and invalid names', async () => {
            // ARRANGE
            await fs.mkdir(path.join(root, 'no-config'));
            await fs.writeFile(path.join(root, 'stray.json'), '{}');
            await writeCollectionConfig(root, 'Invalid_Name', {
                ...createTestConfig(),
                table: 'Invalid_Name',
            });

            // ACT
            const db = await openDatabase();

            // ASSERT
            expect(db.collections()).toEqual([]);
        });

        test('throws INVALID_CONFIG when config is not valid JSON', async () => {
            // ARRANGE
            await writeCollectionConfig(root, TEST_COLLECTION, '{ broken');

            // ACT & ASSERT
            await expect(openDatabase()).rejects.toMatchObject({
                code: 'INVALID_CONFIG',
                status: 500,
            });
        });

        test('throws INVALID_CONFIG when config does not match the directory', async () => {
            // ARRANGE
            await writeCollectionConfig(root, TEST_COLLECTION, {
                ...createTestConfig(),
                table: 'something-else',
            });

            // ACT & ASSERT
            await expect(openDatabase()).rejects.toMatchObject({
                code: 'INVALID_CONFIG',
            });
        });

        test('loads records persisted by a previous instance', async () => {
            // ARRANGE
            await writeCollectionConfig(
                root,
                TEST_COLLECTION,
                createTestConfig()
            );
            const first = await openDatabase();
            const record = await first.create(TEST_COLLECTION, {
                title: 'Persisted',
            });

            // ACT
            await first.close();
            const second = await openDatabase();

            // ASSERT
            await expect(
                second.get(TEST_COLLECTION, record.id)
            ).resolves.toEqual(record);
            const result = await second.list(TEST_COLLECTION, {
                where: { title: 'Persisted' },
            });
            expect(result.total).toBe(1);
        });
    });

    describe('lifecycle', () => {
        const lockPath = () => path.join(root, '.lock');

        function deferred() {
            let resolve;
            const promise = new Promise((r) => {
                resolve = r;
            });
            return { promise, resolve };
        }

        beforeEach(async () => {
            await writeCollectionConfig(
                root,
                TEST_COLLECTION,
                createTestConfig()
            );
        });

        test('init takes the directory lock and close releases it', async () => {
            // ACT
            const db = await openDatabase();

            // ASSERT
            expect(JSON.parse(await fs.readFile(lockPath(), 'utf8')).pid).toBe(
                process.pid
            );
            await db.close();
            await expect(fs.access(lockPath())).rejects.toThrow();
        });

        test('init fails while another live process holds the directory', async () => {
            // ARRANGE
            await fs.writeFile(
                lockPath(),
                JSON.stringify({
                    pid: process.ppid,
                    hostname: os.hostname(),
                    startedAt: 'earlier',
                })
            );
            const db = new FileDatabase(root);

            // ACT & ASSERT
            await expect(db.init()).rejects.toMatchObject({
                code: 'DATABASE_LOCKED',
            });
            expect(() => db.collections()).toThrow(
                expect.objectContaining({ code: 'DATABASE_NOT_READY' })
            );
        });

        test('a second open database on the same directory is rejected, even in one process', async () => {
            // ARRANGE: two instances keep separate indexes and would diverge
            const first = await openDatabase();

            // ACT & ASSERT
            await expect(openDatabase()).rejects.toMatchObject({
                code: 'DATABASE_LOCKED',
            });
            await first.close();
            const second = await openDatabase();
            expect(second.collections()).toEqual([TEST_COLLECTION]);
            await second.close();
        });

        test('starts after a crash that left a lock with the same PID', async () => {
            // ARRANGE: e.g. PID 1 of a restarted container
            await fs.writeFile(
                lockPath(),
                JSON.stringify({
                    pid: process.pid,
                    threadId,
                    hostname: os.hostname(),
                    startedAt: 'before the crash',
                    token: 'previous-run',
                })
            );

            // ACT
            const db = await openDatabase();

            // ASSERT
            expect(db.collections()).toEqual([TEST_COLLECTION]);
            await db.close();
        });

        test('a failed init releases the lock', async () => {
            // ARRANGE
            await writeCollectionConfig(root, 'broken', '{ nope');

            // ACT
            await expect(openDatabase()).rejects.toMatchObject({
                code: 'INVALID_CONFIG',
            });

            // ASSERT
            await expect(fs.access(lockPath())).rejects.toThrow();
        });

        test('init twice on the same instance is rejected', async () => {
            // ARRANGE
            const db = await openDatabase();

            // ACT & ASSERT
            await expect(db.init()).rejects.toMatchObject({
                code: 'DATABASE_ALREADY_INITIALIZED',
            });
        });

        test('regression: of two instances opened at the same time only one opens', async () => {
            // ARRANGE
            const instances = [new FileDatabase(root), new FileDatabase(root)];

            // ACT: either may win, depending on which reaches the lock first
            const results = await Promise.allSettled(
                instances.map((db) => db.init())
            );

            // ASSERT
            const winner = results.findIndex((r) => r.status === 'fulfilled');
            const loser = 1 - winner;
            expect(results.map((r) => r.status).sort()).toEqual([
                'fulfilled',
                'rejected',
            ]);
            expect(results[loser].reason).toMatchObject({
                code: 'DATABASE_LOCKED',
            });
            await instances[winner].close();
            await expect(instances[loser].init()).resolves.toBe(
                instances[loser]
            );
            await instances[loser].close();
        });

        test('init while the same instance is opening is rejected', async () => {
            // ARRANGE
            const db = new FileDatabase(root);

            // ACT
            const opening = db.init();
            const again = db.init();

            // ASSERT
            await expect(again).rejects.toMatchObject({
                code: 'DATABASE_ALREADY_INITIALIZED',
                message: 'The database is already being initialized.',
            });
            await expect(opening).resolves.toBe(db);
            await db.close();
        });

        test('init can be retried after a failed init', async () => {
            // ARRANGE
            await writeCollectionConfig(root, 'broken', '{ nope');
            const db = new FileDatabase(root);
            await expect(db.init()).rejects.toMatchObject({
                code: 'INVALID_CONFIG',
            });

            // ACT
            await fs.rm(path.join(root, 'broken'), { recursive: true });

            // ASSERT
            await expect(db.init()).resolves.toBe(db);
            await db.close();
        });

        test('calls after close fail with DATABASE_CLOSED', async () => {
            // ARRANGE
            const db = await openDatabase();

            // ACT
            await db.close();

            // ASSERT
            expect(() => db.collections()).toThrow(
                expect.objectContaining({
                    code: 'DATABASE_CLOSED',
                    status: 503,
                })
            );
            await expect(db.list(TEST_COLLECTION)).rejects.toMatchObject({
                code: 'DATABASE_CLOSED',
            });
            await expect(
                db.create(TEST_COLLECTION, { title: 'x' })
            ).rejects.toMatchObject({ code: 'DATABASE_CLOSED' });
            await expect(db.close()).resolves.toBeUndefined();
        });

        test('close waits for the running transaction to commit', async () => {
            // ARRANGE
            const db = await openDatabase();
            const gate = deferred();
            const running = db.transaction(async (tx) => {
                await tx.create(TEST_COLLECTION, { title: 'In flight' });
                await gate.promise;
            });
            await new Promise((r) => setTimeout(r, 5));

            // ACT
            let closed = false;
            const closing = db.close().then(() => {
                closed = true;
            });
            await new Promise((r) => setTimeout(r, 5));

            // ASSERT
            expect(closed).toBe(false);
            await expect(db.list(TEST_COLLECTION)).rejects.toMatchObject({
                code: 'DATABASE_CLOSED',
            });
            gate.resolve();
            await Promise.all([running, closing]);
            const reopened = await openDatabase();
            expect((await reopened.list(TEST_COLLECTION)).total).toBe(1);
        });

        test('operations queued before close still run', async () => {
            // ARRANGE
            const db = await openDatabase();
            const gate = deferred();
            const first = db.transaction(async () => {
                await gate.promise;
            });
            const queued = db.create(TEST_COLLECTION, { title: 'Queued' });

            // ACT
            const closing = db.close();
            gate.resolve();

            // ASSERT
            await expect(queued).resolves.toMatchObject({ title: 'Queued' });
            await Promise.all([first, closing]);
        });

        test('the database can be opened again after close', async () => {
            // ARRANGE
            const db = await openDatabase();
            const record = await db.create(TEST_COLLECTION, { title: 'Kept' });
            await db.close();

            // ACT
            await db.init();

            // ASSERT
            await expect(db.get(TEST_COLLECTION, record.id)).resolves.toEqual(
                record
            );
            await db.close();
        });

        test('rejects an invalid transaction timeout', () => {
            // ACT & ASSERT
            expect(
                () => new FileDatabase(root, { transactionTimeout: -1 })
            ).toThrow(TypeError);
            expect(
                () => new FileDatabase(root, { transactionTimeout: '5s' })
            ).toThrow(TypeError);
        });
    });

    describe('warnings', () => {
        async function writeLegacyRecord() {
            const directory = await writeCollectionConfig(
                root,
                TEST_COLLECTION,
                createTestConfig()
            );
            const id = uuidv7();
            await fs.writeFile(
                path.join(directory, `${id}.json`),
                JSON.stringify({ id, title: 'Old', removedColumn: true })
            );
            return id;
        }

        test('records that do not match the schema are reported, not fatal', async () => {
            // ARRANGE
            const id = await writeLegacyRecord();
            const logger = createTestLogger();

            // ACT
            const db = new FileDatabase(root, { logger });
            await db.init();

            // ASSERT
            expect(db.warnings).toEqual([
                {
                    code: 'INVALID_RECORD',
                    collection: TEST_COLLECTION,
                    id,
                    message: expect.stringMatching(
                        /Unknown field "removedColumn"/
                    ),
                },
            ]);
            expect(logger.at('warn')).toEqual([
                {
                    level: 'warn',
                    fields: {
                        code: 'INVALID_RECORD',
                        collection: TEST_COLLECTION,
                        id,
                    },
                    message:
                        'Record does not match the schema: Unknown field "removedColumn".',
                },
            ]);
            await expect(db.get(TEST_COLLECTION, id)).resolves.toMatchObject({
                title: 'Old',
            });
        });

        test('without a logger, warnings go to console.warn', async () => {
            // ARRANGE
            const id = await writeLegacyRecord();
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            try {
                // ACT
                await openDatabase();

                // ASSERT
                expect(warn).toHaveBeenCalledWith(
                    expect.stringMatching(
                        new RegExp(
                            `^\\[file-database\\] Record does not match.*"id":"${id}"`
                        )
                    )
                );
            } finally {
                warn.mockRestore();
            }
        });

        test('a clean database has no warnings', async () => {
            // ARRANGE
            await writeCollectionConfig(
                root,
                TEST_COLLECTION,
                createTestConfig()
            );

            // ACT & ASSERT
            expect((await openDatabase()).warnings).toEqual([]);
        });

        test('warnings is a copy', async () => {
            // ARRANGE
            await writeLegacyRecord();
            const db = new FileDatabase(root, { logger: createTestLogger() });
            await db.init();

            // ACT
            db.warnings.pop();

            // ASSERT
            expect(db.warnings).toHaveLength(1);
        });
    });

    describe('collection routing', () => {
        test('methods throw DATABASE_NOT_READY before init', async () => {
            // ARRANGE
            const db = new FileDatabase(root);

            // ACT & ASSERT
            expect(() => db.collections()).toThrow(DatabaseError);
            await expect(db.list(TEST_COLLECTION)).rejects.toMatchObject({
                code: 'DATABASE_NOT_READY',
                status: 503,
            });
        });

        test('throws INVALID_COLLECTION for malformed names', async () => {
            // ARRANGE
            const db = await openDatabase();

            // ACT & ASSERT
            for (const name of ['', 'Upper', '../etc', 42]) {
                expect(() => db.schema(name)).toThrow(
                    expect.objectContaining({
                        code: 'INVALID_COLLECTION',
                        status: 400,
                    })
                );
            }
        });

        test('throws COLLECTION_NOT_FOUND for unknown collections', async () => {
            // ARRANGE
            const db = await openDatabase();

            // ACT & ASSERT
            await expect(db.get('missing', uuidv7())).rejects.toMatchObject({
                code: 'COLLECTION_NOT_FOUND',
                status: 404,
            });
        });

        test('delegates CRUD operations to the collection', async () => {
            // ARRANGE
            await writeCollectionConfig(
                root,
                TEST_COLLECTION,
                createTestConfig()
            );
            const db = await openDatabase();

            // ACT & ASSERT
            const created = await db.create(TEST_COLLECTION, {
                title: 'Facade',
                number: 1,
            });
            await expect(db.get(TEST_COLLECTION, created.id)).resolves.toEqual(
                created
            );

            const patched = await db.update(TEST_COLLECTION, created.id, {
                number: 2,
            });
            expect(patched.number).toBe(2);

            const replaced = await db.update(
                TEST_COLLECTION,
                created.id,
                { title: 'Replaced' },
                { replace: true }
            );
            expect(replaced).toEqual({ id: created.id, title: 'Replaced' });

            const listed = await db.list(TEST_COLLECTION, {
                predicate: eq('title', 'Replaced'),
            });
            expect(listed.items).toEqual([replaced]);

            await db.delete(TEST_COLLECTION, created.id);
            await expect(
                db.get(TEST_COLLECTION, created.id)
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });
    });
});
