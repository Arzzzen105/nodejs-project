import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
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
