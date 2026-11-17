import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileDatabase } from '../../src/storage/file-database.js';
import { ChangeLog } from '../../src/storage/change-log.js';
import { Collection } from '../../src/storage/collection.js';
import { Journal } from '../../src/storage/journal.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
    fileExists,
} from '../helpers/temp-db.js';

const OWNERS = {
    table: 'owners',
    primaryKey: 'id',
    columns: { name: { type: 'string', required: true } },
    indexes: [],
};

/**
 * Every commit, whatever point a crash interrupts it at, ends up in the change
 * log exactly once after the next start. A crash is reproduced by making one
 * step of a real commit fail, which leaves the files as a crash at that step
 * would, and then opening the database again.
 */
describe('change log recovery on start', () => {
    let root;
    let db;
    let ann;

    const open = async () => {
        db = await new FileDatabase(root).init();
        return db;
    };
    const reopen = async () => {
        await db.close();
        return open();
    };
    const logged = async () => {
        const entries = [];
        for await (const entry of new ChangeLog(root).entries()) {
            entries.push(entry);
        }
        return entries;
    };
    const journalPath = () => new Journal(root).path;

    /** Renames Ann to Anna in a commit that fails at the given step. */
    const interruptedRename = async (step) => {
        const failing = vi
            .spyOn(...step)
            .mockRejectedValueOnce(new Error('crash'));
        try {
            await db.update('owners', ann.id, { name: 'Anna' }).catch(() => {});
        } finally {
            failing.mockRestore();
        }
    };

    beforeEach(async () => {
        root = await createTempDir();
        await writeCollectionConfig(root, 'owners', OWNERS);
        await open();
        ann = await db.create('owners', { name: 'Ann' });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await db?.close();
        await removeDir(root);
    });

    /** The change log after the rename was recovered: two lines, the second the rename. */
    const expectRenameLoggedOnce = async () => {
        const entries = await logged();
        expect(entries).toHaveLength(2);
        expect(entries[1].changes).toEqual([
            {
                collection: 'owners',
                id: ann.id,
                op: 'update',
                before: ann,
                after: { ...ann, name: 'Anna' },
            },
        ]);
        expect(await fileExists(journalPath())).toBe(false);
        expect((await db.get('owners', ann.id)).name).toBe('Anna');
    };

    test('crash after the journal, before the files: applied and logged on start', async () => {
        // ARRANGE
        await interruptedRename([Collection.prototype, 'applyPut']);
        expect(await logged()).toHaveLength(1);

        // ACT
        await reopen();

        // ASSERT
        await expectRenameLoggedOnce();
    });

    test('crash after the files, before the change log: logged on start', async () => {
        // ARRANGE
        await interruptedRename([ChangeLog.prototype, 'append']);
        expect(await logged()).toHaveLength(1);
        expect(await fileExists(journalPath())).toBe(true);

        // ACT
        await reopen();

        // ASSERT
        await expectRenameLoggedOnce();
    });

    test('crash after the change log, before the journal is removed: not logged twice', async () => {
        // ARRANGE
        await interruptedRename([Journal.prototype, 'clear']);
        expect(await logged()).toHaveLength(2);
        expect(await fileExists(journalPath())).toBe(true);

        // ACT
        await reopen();

        // ASSERT
        await expectRenameLoggedOnce();
    });

    test('crash in the middle of the change log line: the torn line is replaced', async () => {
        // ARRANGE: the line was cut off while being written
        await interruptedRename([ChangeLog.prototype, 'append']);
        const { entry } = await new Journal(root).recover();
        const line = JSON.stringify(entry);
        const [file] = await fs.readdir(path.join(root, '.changes'));
        await fs.appendFile(
            path.join(root, '.changes', file),
            line.slice(0, line.length / 2)
        );

        // ACT
        await reopen();

        // ASSERT
        await expectRenameLoggedOnce();
        expect(entry.tx).toBe((await logged())[1].tx);
    });

    test('crash while writing the journal: nothing happened, nothing is logged', async () => {
        // ARRANGE
        await interruptedRename([Journal.prototype, 'write']);

        // ACT
        await reopen();

        // ASSERT
        expect(await logged()).toHaveLength(1);
        expect((await db.get('owners', ann.id)).name).toBe('Ann');
    });

    test('later starts and commits add nothing twice', async () => {
        // ARRANGE
        await interruptedRename([ChangeLog.prototype, 'append']);
        await reopen();

        // ACT
        await reopen();
        await db.create('owners', { name: 'Bob' });

        // ASSERT
        const entries = await logged();
        expect(entries.map((entry) => entry.changes[0].after.name)).toEqual([
            'Ann',
            'Anna',
            'Bob',
        ]);
        expect(new Set(entries.map((entry) => entry.tx)).size).toBe(3);
    });

    test('if the line cannot be written on start either, start fails and keeps the journal', async () => {
        // ARRANGE
        await interruptedRename([ChangeLog.prototype, 'append']);
        await db.close();
        const append = vi
            .spyOn(ChangeLog.prototype, 'append')
            .mockRejectedValueOnce(new Error('ENOSPC'));

        // ACT & ASSERT
        await expect(open()).rejects.toThrow('ENOSPC');
        append.mockRestore();
        expect(await fileExists(journalPath())).toBe(true);

        // the next start, with the disk fixed, finishes the job
        await open();
        await expectRenameLoggedOnce();
    });

    test('a corrupt change log stops the start and keeps the journal', async () => {
        // ARRANGE
        await interruptedRename([ChangeLog.prototype, 'append']);
        await db.close();
        const [file] = await fs.readdir(path.join(root, '.changes'));
        await fs.appendFile(path.join(root, '.changes', file), 'garbage\n');

        // ACT & ASSERT
        await expect(open()).rejects.toMatchObject({
            code: 'CORRUPT_CHANGE_LOG',
        });
        expect(await fileExists(journalPath())).toBe(true);
        db = null;
    });
});
