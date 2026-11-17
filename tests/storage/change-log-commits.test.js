import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import { FileDatabase } from '../../src/storage/file-database.js';
import { ChangeLog } from '../../src/storage/change-log.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
} from '../helpers/temp-db.js';

const OWNERS = {
    table: 'owners',
    primaryKey: 'id',
    columns: { name: { type: 'string', required: true } },
    indexes: [],
};

const ITEMS = {
    table: 'items',
    primaryKey: 'id',
    timestamps: true,
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
};

const UUID_V7 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('the change log records every commit', () => {
    let root;
    let db;

    const logged = async () => {
        const entries = [];
        for await (const entry of new ChangeLog(root).entries()) {
            entries.push(entry);
        }
        return entries;
    };

    beforeEach(async () => {
        root = await createTempDir();
        await writeCollectionConfig(root, 'owners', OWNERS);
        await writeCollectionConfig(root, 'items', ITEMS);
        db = await new FileDatabase(root).init();
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    test('create, update and delete each write one line with before and after', async () => {
        // ACT
        const ann = await db.create('owners', { name: 'Ann' });
        const renamed = await db.update('owners', ann.id, { name: 'Anna' });
        await db.delete('owners', ann.id);

        // ASSERT
        const entries = await logged();
        expect(entries.map((entry) => entry.changes)).toEqual([
            [
                {
                    collection: 'owners',
                    id: ann.id,
                    op: 'create',
                    before: null,
                    after: ann,
                },
            ],
            [
                {
                    collection: 'owners',
                    id: ann.id,
                    op: 'update',
                    before: ann,
                    after: renamed,
                },
            ],
            [
                {
                    collection: 'owners',
                    id: ann.id,
                    op: 'delete',
                    before: renamed,
                    after: null,
                },
            ],
        ]);
    });

    test('a line carries a time-ordered tx id, the commit time and a context', async () => {
        // ARRANGE
        const started = new Date().toISOString();

        // ACT
        await db.create('owners', { name: 'Ann' });
        await db.create('owners', { name: 'Bob' });

        // ASSERT
        const [first, second] = await logged();
        expect(first.tx).toMatch(UUID_V7);
        expect(first.tx < second.tx).toBe(true);
        expect(first.at >= started).toBe(true);
        expect(first.at <= second.at).toBe(true);
        expect(first.context).toBeNull();
    });

    test('a transaction is one line with all its changes', async () => {
        // ACT
        const { ann, lamp } = await db.transaction(async (tx) => {
            const ann = await tx.create('owners', { name: 'Ann' });
            const lamp = await tx.create('items', {
                title: 'Lamp',
                ownerId: ann.id,
            });
            return { ann, lamp };
        });

        // ASSERT
        const entries = await logged();
        expect(entries).toHaveLength(1);
        expect(entries[0].changes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: ann.id, op: 'create' }),
                expect.objectContaining({ id: lamp.id, op: 'create' }),
            ])
        );
        expect(entries[0].changes).toHaveLength(2);
    });

    test('references cleared by onDelete are part of the same line', async () => {
        // ARRANGE
        const ann = await db.create('owners', { name: 'Ann' });
        const lamp = await db.create('items', {
            title: 'Lamp',
            ownerId: ann.id,
        });

        // ACT
        await db.delete('owners', ann.id);

        // ASSERT
        const last = (await logged()).at(-1);
        expect(last.changes).toEqual([
            expect.objectContaining({
                collection: 'items',
                id: lamp.id,
                op: 'update',
                before: lamp,
                after: expect.objectContaining({ ownerId: null }),
            }),
            expect.objectContaining({
                collection: 'owners',
                id: ann.id,
                op: 'delete',
            }),
        ]);
    });

    describe('what is not a change is not recorded', () => {
        test('a rolled back transaction', async () => {
            await expect(
                db.transaction(async (tx) => {
                    await tx.create('owners', { name: 'Ann' });
                    throw new Error('business rule');
                })
            ).rejects.toThrow('business rule');
            await db.transaction(async (tx) => {
                await tx.create('owners', { name: 'Bob' });
                tx.rollback();
            });

            expect(await logged()).toEqual([]);
        });

        test('an update to the same values', async () => {
            // ARRANGE
            const ann = await db.create('owners', { name: 'Ann' });
            const lamp = await db.create('items', { title: 'Lamp' });

            // ACT: with and without timestamps
            await db.update('owners', ann.id, { name: 'Ann' });
            await db.update('items', lamp.id, {});

            // ASSERT
            expect(await logged()).toHaveLength(2);
        });

        test('a record created and deleted in one transaction', async () => {
            await db.transaction(async (tx) => {
                const ann = await tx.create('owners', { name: 'Ann' });
                await tx.delete('owners', ann.id);
            });

            expect(await logged()).toEqual([]);
        });

        test('a change undone later in the same transaction', async () => {
            // ARRANGE
            const ann = await db.create('owners', { name: 'Ann' });

            // ACT
            await db.transaction(async (tx) => {
                await tx.update('owners', ann.id, { name: 'Temp' });
                await tx.update('owners', ann.id, { name: 'Ann' });
            });

            // ASSERT
            expect(await logged()).toHaveLength(1);
        });

        test('a failed operation the transaction handled', async () => {
            // ACT
            await db.transaction(async (tx) => {
                await expect(tx.create('owners', {})).rejects.toMatchObject({
                    code: 'VALIDATION_ERROR',
                });
                await tx.create('owners', { name: 'Ann' });
            });

            // ASSERT
            const entries = await logged();
            expect(entries).toHaveLength(1);
            expect(
                entries[0].changes.map((change) => change.after.name)
            ).toEqual(['Ann']);
        });
    });

    test('lines survive a restart and later commits are added after them', async () => {
        // ARRANGE
        await db.create('owners', { name: 'Ann' });
        await db.close();

        // ACT
        db = await new FileDatabase(root).init();
        await db.create('owners', { name: 'Bob' });

        // ASSERT
        expect(
            (await logged()).map((entry) => entry.changes[0].after.name)
        ).toEqual(['Ann', 'Bob']);
    });
});
