import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Journal } from '../../src/storage/journal.js';
import { createTempDir, removeDir, fileExists } from '../helpers/temp-db.js';

const CHANGES = [
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

    test('write then recover returns the same changes', async () => {
        // ACT
        await journal.write(CHANGES);

        // ASSERT
        await expect(new Journal(root).recover()).resolves.toEqual(CHANGES);
    });

    test('an empty change list is a valid journal', async () => {
        // ACT
        await journal.write([]);

        // ASSERT
        await expect(journal.recover()).resolves.toEqual([]);
    });

    test('write replaces a previous journal', async () => {
        // ARRANGE
        await journal.write(CHANGES);

        // ACT
        await journal.write([CHANGES[1]]);

        // ASSERT
        await expect(journal.recover()).resolves.toEqual([CHANGES[1]]);
    });

    test('clear removes the journal and is idempotent', async () => {
        // ARRANGE
        await journal.write(CHANGES);

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
            await expectCorrupt(JSON.stringify({ version: 2, changes: [] }));
            await expectCorrupt(JSON.stringify({ version: 1 }));
            await expectCorrupt(JSON.stringify([]));
        });

        test('malformed changes', async () => {
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
