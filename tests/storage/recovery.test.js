import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { FileDatabase } from '../../src/storage/file-database.js';
import { Journal } from '../../src/storage/journal.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
    fileExists,
} from '../helpers/temp-db.js';

const CONFIGS = {
    owners: {
        table: 'owners',
        primaryKey: 'id',
        columns: { name: { type: 'string', required: true } },
        indexes: ['name'],
    },
    items: {
        table: 'items',
        primaryKey: 'id',
        columns: {
            title: { type: 'string', required: true },
            ownerId: {
                type: 'string',
                nullable: true,
                default: null,
                references: { collection: 'owners', onDelete: 'setNull' },
            },
        },
        indexes: [],
    },
};

describe('Journal recovery on init', () => {
    let root;
    let db;
    let journal;

    async function openDatabase() {
        return new FileDatabase(root).init();
    }

    /** Closes the open database and opens the directory again. */
    async function reopen() {
        await db?.close();
        db = await openDatabase();
        return db;
    }

    beforeEach(async () => {
        root = await createTempDir();
        for (const [name, config] of Object.entries(CONFIGS)) {
            await writeCollectionConfig(root, name, config);
        }
        db = await openDatabase();
        journal = new Journal(root);
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    test('starts normally without a journal', async () => {
        // ACT & ASSERT
        await expect(reopen()).resolves.toBeInstanceOf(FileDatabase);
    });

    test('applies puts and deletes of an unfinished commit', async () => {
        // ARRANGE
        const kept = await db.create('owners', { name: 'Kept' });
        const renamed = await db.create('owners', { name: 'Old' });
        const removed = await db.create('owners', { name: 'Removed' });
        const added = { id: uuidv7(), name: 'Added' };
        await journal.write([
            {
                collection: 'owners',
                id: renamed.id,
                record: { ...renamed, name: 'New' },
            },
            { collection: 'owners', id: removed.id, record: null },
            { collection: 'owners', id: added.id, record: added },
        ]);

        // ACT
        const reopened = await reopen();

        // ASSERT
        await expect(reopened.get('owners', kept.id)).resolves.toEqual(kept);
        await expect(reopened.get('owners', renamed.id)).resolves.toEqual({
            ...renamed,
            name: 'New',
        });
        await expect(reopened.get('owners', removed.id)).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
        await expect(reopened.get('owners', added.id)).resolves.toEqual(added);
        expect(await fileExists(journal.path)).toBe(false);
    });

    test('indexes reflect the recovered state', async () => {
        // ARRANGE
        const owner = await db.create('owners', { name: 'Old' });
        await journal.write([
            {
                collection: 'owners',
                id: owner.id,
                record: { ...owner, name: 'New' },
            },
        ]);

        // ACT
        const reopened = await reopen();

        // ASSERT
        const byOld = await reopened.list('owners', { where: { name: 'Old' } });
        const byNew = await reopened.list('owners', { where: { name: 'New' } });
        expect(byOld.total).toBe(0);
        expect(byNew.total).toBe(1);
    });

    test('a crash in the middle of a multi-record commit is completed on restart', async () => {
        // ARRANGE: delete of an owner with two referencing items
        const owner = await db.create('owners', { name: 'Ann' });
        const a = await db.create('items', { title: 'A', ownerId: owner.id });
        const b = await db.create('items', { title: 'B', ownerId: owner.id });
        const changes = [
            { collection: 'items', id: a.id, record: { ...a, ownerId: null } },
            { collection: 'items', id: b.id, record: { ...b, ownerId: null } },
            { collection: 'owners', id: owner.id, record: null },
        ];
        await journal.write(changes);
        // simulate the crash: only the first change reached the record files
        await fs.writeFile(
            path.join(root, 'items', `${a.id}.json`),
            JSON.stringify(changes[0].record)
        );

        // ACT
        const reopened = await reopen();

        // ASSERT: without the journal this state would fail the integrity check
        expect((await reopened.get('items', a.id)).ownerId).toBeNull();
        expect((await reopened.get('items', b.id)).ownerId).toBeNull();
        await expect(reopened.get('owners', owner.id)).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    test('a journal that was already fully applied is applied again safely', async () => {
        // ARRANGE: crash after applying everything but before clearing the journal
        const owner = await db.create('owners', { name: 'Ann' });
        await db.delete('owners', owner.id);
        await journal.write([
            { collection: 'owners', id: owner.id, record: null },
        ]);

        // ACT & ASSERT
        const reopened = await reopen();
        expect(reopened.collections().sort()).toEqual(['items', 'owners']);
        expect(await fileExists(journal.path)).toBe(false);
    });

    test('warnings reflect the state after the journal is applied', async () => {
        // ARRANGE: a record with an outdated field, fixed by the journal...
        const fixed = { id: uuidv7(), name: 'Fixed' };
        await fs.writeFile(
            path.join(root, 'owners', `${fixed.id}.json`),
            JSON.stringify({ ...fixed, removedColumn: 1 })
        );
        // ...and a record the journal writes without a required field
        const broken = { id: uuidv7() };
        await journal.write([
            { collection: 'owners', id: fixed.id, record: fixed },
            { collection: 'owners', id: broken.id, record: broken },
        ]);
        await db.close();
        const reported = [];

        // ACT
        db = new FileDatabase(root, {
            onWarning: (warning) => reported.push(warning),
        });
        await db.init();

        // ASSERT
        expect(reported).toEqual([
            {
                code: 'INVALID_RECORD',
                collection: 'owners',
                id: broken.id,
                message: '"name" is required.',
            },
        ]);
        expect(db.warnings).toEqual(reported);
    });

    test('an interrupted journal write is ignored', async () => {
        // ARRANGE: crash before the journal rename, i.e. before the commit point
        const owner = await db.create('owners', { name: 'Ann' });
        await fs.writeFile(
            path.join(root, 'journal.json.abc.tmp'),
            JSON.stringify({
                version: 1,
                changes: [{ collection: 'owners', id: owner.id, record: null }],
            })
        );

        // ACT
        const reopened = await reopen();

        // ASSERT
        await expect(reopened.get('owners', owner.id)).resolves.toEqual(owner);
        expect(await fs.readdir(root)).not.toContain('journal.json.abc.tmp');
    });

    test.each([
        [
            'unknown collection',
            () => ({ collection: 'ghosts', id: uuidv7(), record: null }),
        ],
        [
            'invalid id',
            () => ({ collection: 'owners', id: 'nope', record: null }),
        ],
        [
            'record id mismatch',
            () => ({
                collection: 'owners',
                id: uuidv7(),
                record: { id: uuidv7(), name: 'x' },
            }),
        ],
    ])('fails with CORRUPT_JOURNAL for %s', async (_label, change) => {
        // ARRANGE
        await journal.write([change()]);

        // ACT & ASSERT
        await expect(reopen()).rejects.toMatchObject({
            code: 'CORRUPT_JOURNAL',
        });
        expect(await fileExists(journal.path)).toBe(true);
    });

    test('keeps the journal when the recovered state has broken references', async () => {
        // ARRANGE
        const item = { id: uuidv7(), title: 'A', ownerId: uuidv7() };
        await journal.write([
            { collection: 'items', id: item.id, record: item },
        ]);

        // ACT & ASSERT
        await expect(reopen()).rejects.toMatchObject({
            code: 'BROKEN_REFERENCES',
        });
        expect(await fileExists(journal.path)).toBe(true);
    });
});
