import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileDatabase } from '../../src/storage/file-database.js';
import { copySchema } from '../../scripts/copy-schema.js';
import { clearDatabase } from '../../scripts/clear-db.js';
import { createTempDir, removeDir } from '../helpers/temp-db.js';

const SCHEMA = path.resolve(import.meta.dirname, '..', '..', 'database');

describe('scripts/clear-db.js', () => {
    let root;
    let collections;

    beforeEach(async () => {
        root = await createTempDir();
        collections = await copySchema(SCHEMA, root);
        // records, and with them the history of changes
        const db = await new FileDatabase(root).init();
        const group = await db.create('groups', { name: 'Bees', age: 3 });
        await db.create('kids', {
            firstName: 'Marko',
            lastName: 'Koval',
            age: 3,
            sex: 'MALE',
            groupId: group.id,
        });
        await db.create('subjects', { name: 'Music' });
        await db.close();
    });

    afterEach(async () => removeDir(root));

    /** Every file of the directory, relative to it. */
    const files = async () =>
        (await fs.readdir(root, { recursive: true, withFileTypes: true }))
            .filter((entry) => entry.isFile())
            .map((entry) =>
                path.relative(root, path.join(entry.parentPath, entry.name))
            )
            .sort();

    test('deletes the records and the history; the schemas stay', async () => {
        // ACT
        const report = await clearDatabase(root);

        // ASSERT
        expect(report.records).toBe(3);
        expect(report.history).toBeGreaterThan(0);
        expect(report.collections.filter((c) => c.records > 0)).toEqual([
            { name: 'groups', records: 1 },
            { name: 'kids', records: 1 },
            { name: 'subjects', records: 1 },
        ]);
        const left = await files();
        expect(left.every((file) => file.endsWith('config.json'))).toBe(true);
        expect(left).toHaveLength(collections.length);
    });

    test('the database opens empty after it, with the same schema', async () => {
        await clearDatabase(root);

        const db = await new FileDatabase(root).init();
        try {
            expect((await db.list('kids')).total).toBe(0);
            expect(await db.changes()).toEqual([]);
            expect(db.collections().sort()).toEqual(collections);
        } finally {
            await db.close();
        }
    });

    test('a dry run deletes nothing, and tells what it would', async () => {
        const before = await files();

        const report = await clearDatabase(root, { dryRun: true });

        expect(report.records).toBe(3);
        expect(await files()).toEqual(before);
    });

    test('refuses while a server uses the database, and deletes nothing', async () => {
        const db = await new FileDatabase(root).init();
        try {
            const before = await files();

            await expect(clearDatabase(root)).rejects.toMatchObject({
                code: 'DATABASE_LOCKED',
            });
            expect(await files()).toEqual(before);
        } finally {
            await db.close();
        }
    });

    test('a journal left by a crash goes too; what it does not know stays', async () => {
        await fs.writeFile(path.join(root, 'journal.json'), '{}');
        await fs.writeFile(path.join(root, 'README.txt'), 'notes');
        await fs.mkdir(path.join(root, 'backup'));
        await fs.writeFile(path.join(root, 'backup', 'kids.json'), '[]');

        const report = await clearDatabase(root);

        expect(report.leftovers).toEqual(['journal.json']);
        const left = await files();
        expect(left).not.toContain('journal.json');
        expect(left).toEqual(
            expect.arrayContaining(['README.txt', 'backup/kids.json'])
        );
    });

    test('an empty database stays as it is', async () => {
        await clearDatabase(root);

        const report = await clearDatabase(root);

        expect(report).toMatchObject({ records: 0, history: 0 });
    });
});
