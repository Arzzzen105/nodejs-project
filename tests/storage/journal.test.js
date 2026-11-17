import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Journal } from '../../src/storage/journal.js';
import { createTempDir, removeDir, fileExists } from '../helpers/temp-db.js';

const ENTRY = {
    tx: '0190a000-0000-7000-8000-000000000001',
    at: '2026-11-17T10:00:00.000Z',
    context: { requestId: 'r1' },
    changes: [
        {
            collection: 'items',
            id: 'a',
            op: 'update',
            before: { id: 'a', title: 'Old' },
            after: { id: 'a', title: 'A' },
        },
        {
            collection: 'items',
            id: 'b',
            op: 'delete',
            before: { id: 'b', title: 'B' },
            after: null,
        },
    ],
};

// what the files get from ENTRY
const APPLIED = [
    { collection: 'items', id: 'a', record: { id: 'a', title: 'A' } },
    { collection: 'items', id: 'b', record: null },
];

describe('Journal', () => {
    let root;
    let journal;

    beforeEach(async () => {
        root = await createTempDir();
        journal = new Journal(root);
    });

    afterEach(async () => {
        await removeDir(root);
    });

    test('stores the journal as journal.json in the root', () => {
        expect(journal.path).toBe(path.join(root, 'journal.json'));
    });

    test('recover returns null when there is no journal', async () => {
        await expect(journal.recover()).resolves.toBeNull();
    });

    test('write then recover returns the commit and the changes to apply', async () => {
        // ACT
        await journal.write(ENTRY);

        // ASSERT
        await expect(new Journal(root).recover()).resolves.toEqual({
            entry: ENTRY,
            changes: APPLIED,
        });
    });

    test('stores the commit whole, as version 2', async () => {
        // ACT
        await journal.write(ENTRY);

        // ASSERT
        expect(JSON.parse(await fs.readFile(journal.path, 'utf8'))).toEqual({
            version: 2,
            entry: ENTRY,
        });
    });

    test('a commit without changes is a valid journal', async () => {
        // ACT
        await journal.write({ ...ENTRY, changes: [] });

        // ASSERT
        await expect(journal.recover()).resolves.toEqual({
            entry: { ...ENTRY, changes: [] },
            changes: [],
        });
    });

    test('op and before are optional', async () => {
        // ARRANGE
        const entry = {
            ...ENTRY,
            context: null,
            changes: [{ collection: 'items', id: 'a', after: null }],
        };

        // ACT
        await journal.write(entry);

        // ASSERT
        await expect(journal.recover()).resolves.toEqual({
            entry,
            changes: [{ collection: 'items', id: 'a', record: null }],
        });
    });

    test('write replaces a previous journal', async () => {
        // ARRANGE
        await journal.write(ENTRY);
        const next = { ...ENTRY, tx: 'next', changes: [ENTRY.changes[1]] };

        // ACT
        await journal.write(next);

        // ASSERT
        await expect(journal.recover()).resolves.toEqual({
            entry: next,
            changes: [APPLIED[1]],
        });
    });

    test('a version 1 journal of an older server is still recovered, without a commit', async () => {
        // ARRANGE
        await fs.writeFile(
            journal.path,
            JSON.stringify({ version: 1, changes: APPLIED })
        );

        // ACT & ASSERT
        await expect(journal.recover()).resolves.toEqual({
            entry: null,
            changes: APPLIED,
        });
    });

    test('clear removes the journal and is idempotent', async () => {
        // ARRANGE
        await journal.write(ENTRY);

        // ACT
        await journal.clear();
        await journal.clear();

        // ASSERT
        expect(await fileExists(journal.path)).toBe(false);
        await expect(journal.recover()).resolves.toBeNull();
    });

    test('recover removes temporary files of interrupted writes', async () => {
        // ARRANGE: a write that crashed before its rename (commit point)
        await fs.writeFile(
            path.join(root, 'journal.json.0000.tmp'),
            '{"version":1,"chan'
        );
        await fs.writeFile(path.join(root, 'other.tmp'), 'keep');

        // ACT
        const changes = await journal.recover();

        // ASSERT
        expect(changes).toBeNull();
        expect(await fs.readdir(root)).toEqual(['other.tmp']);
    });

    describe('corrupt journals', () => {
        const expectCorrupt = async (content) => {
            await fs.writeFile(journal.path, content);
            await expect(journal.recover()).rejects.toMatchObject({
                code: 'CORRUPT_JOURNAL',
                status: 500,
            });
        };

        test('invalid JSON', async () => {
            await expectCorrupt('{ broken');
        });

        test('unknown version or shape', async () => {
            await expectCorrupt(JSON.stringify({ version: 3, entry: ENTRY }));
            await expectCorrupt(JSON.stringify({ version: 2 }));
            await expectCorrupt(JSON.stringify({ version: 2, changes: [] }));
            await expectCorrupt(JSON.stringify({ version: 1 }));
            await expectCorrupt(JSON.stringify([]));
        });

        test.each([
            ['without tx', { tx: undefined }],
            ['with a tx that is not a string', { tx: 1 }],
            ['without commit time', { at: undefined }],
            ['with a context that is not an object', { context: 'r1' }],
            ['without changes', { changes: undefined }],
        ])('a commit %s', async (_label, override) => {
            await expectCorrupt(
                JSON.stringify({ version: 2, entry: { ...ENTRY, ...override } })
            );
        });

        test.each([
            ['not an object', 'x'],
            ['without collection', { id: 'a', after: null }],
            ['without id', { collection: 'c', after: null }],
            ['without after', { collection: 'c', id: 'a' }],
            [
                'with an after that is not a record',
                { collection: 'c', id: 'a', after: [1] },
            ],
            [
                'with a before that is not a record',
                { collection: 'c', id: 'a', before: 'x', after: null },
            ],
            [
                'with an unknown op',
                { collection: 'c', id: 'a', op: 'upsert', after: null },
            ],
        ])('a change %s', async (_label, change) => {
            await expectCorrupt(
                JSON.stringify({
                    version: 2,
                    entry: { ...ENTRY, changes: [change] },
                })
            );
        });

        test('malformed changes of a version 1 journal', async () => {
            const journalWith = (change) =>
                JSON.stringify({ version: 1, changes: [change] });
            await expectCorrupt(journalWith('x'));
            await expectCorrupt(journalWith({ id: 'a', record: null }));
            await expectCorrupt(journalWith({ collection: 'c', record: null }));
            await expectCorrupt(
                journalWith({ collection: 'c', id: 'a', record: [1] })
            );
            await expectCorrupt(journalWith({ collection: 'c', id: 'a' }));
        });
    });
});
