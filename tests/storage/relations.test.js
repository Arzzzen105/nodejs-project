import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { FileDatabase } from '../../src/storage/file-database.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
} from '../helpers/temp-db.js';

function collectionConfig(name, columns, indexes = []) {
    return { table: name, primaryKey: 'id', columns, indexes };
}

const CONFIGS = {
    owners: collectionConfig('owners', {
        name: { type: 'string', required: true },
    }),
    tags: collectionConfig('tags', {
        label: { type: 'string', required: true },
    }),
    items: collectionConfig('items', {
        title: { type: 'string', required: true },
        ownerId: {
            type: 'string',
            nullable: true,
            default: null,
            references: { collection: 'owners', onDelete: 'setNull' },
        },
        tagIds: {
            type: 'array',
            default: [],
            items: { references: { collection: 'tags', onDelete: 'remove' } },
        },
    }),
    notes: collectionConfig('notes', {
        text: { type: 'string', required: true },
        itemId: {
            type: 'string',
            required: true,
            references: { collection: 'items' },
        },
    }),
    nodes: collectionConfig('nodes', {
        label: { type: 'string', required: true },
        parentId: {
            type: 'string',
            nullable: true,
            default: null,
            references: { collection: 'nodes', onDelete: 'setNull' },
        },
    }),
};

describe('Relations', () => {
    let root;
    let db;

    async function openDatabase() {
        const database = new FileDatabase(root);
        await database.init();
        return database;
    }

    async function recordFiles(collection) {
        const files = await fs.readdir(path.join(root, collection));
        return files.filter((file) => file !== 'config.json');
    }

    beforeEach(async () => {
        root = await createTempDir();
        for (const [name, config] of Object.entries(CONFIGS)) {
            await writeCollectionConfig(root, name, config);
        }
        db = await openDatabase();
    });

    afterEach(async () => {
        await removeDir(root);
    });

    describe('init', () => {
        test('rejects references to unknown collections', async () => {
            // ARRANGE
            await writeCollectionConfig(
                root,
                'orphans',
                collectionConfig('orphans', {
                    ghostId: {
                        type: 'string',
                        references: { collection: 'ghosts' },
                    },
                })
            );

            // ACT & ASSERT
            await expect(openDatabase()).rejects.toMatchObject({
                code: 'INVALID_CONFIG',
                message: expect.stringMatching(/"ghosts" does not exist/),
            });
        });

        test('fails on broken references stored on disk', async () => {
            // ARRANGE
            const id = uuidv7();
            const missingOwner = uuidv7();
            await fs.writeFile(
                path.join(root, 'items', `${id}.json`),
                JSON.stringify({
                    id,
                    title: 'Broken',
                    ownerId: missingOwner,
                    tagIds: [],
                })
            );

            // ACT & ASSERT
            await expect(openDatabase()).rejects.toMatchObject({
                code: 'BROKEN_REFERENCES',
                message: expect.stringContaining(
                    `items/${id}.ownerId -> owners/"${missingOwner}"`
                ),
            });
        });

        test('a failed init leaves the database not initialized', async () => {
            // ARRANGE
            const id = uuidv7();
            await fs.writeFile(
                path.join(root, 'items', `${id}.json`),
                JSON.stringify({ id, title: 'x', ownerId: uuidv7() })
            );
            const database = new FileDatabase(root);

            // ACT
            await database.init().catch(() => {});

            // ASSERT
            expect(() => database.collections()).toThrow(
                expect.objectContaining({ code: 'DATABASE_NOT_READY' })
            );
        });

        test('reference columns are indexed automatically', async () => {
            // ARRANGE
            const owner = await db.create('owners', { name: 'Ann' });
            const item = await db.create('items', {
                title: 'A',
                ownerId: owner.id,
            });
            await db.create('items', { title: 'B' });

            // ACT
            const result = await db.list('items', {
                where: { ownerId: owner.id },
            });

            // ASSERT
            expect(result.items.map((i) => i.id)).toEqual([item.id]);
        });
    });

    describe('create', () => {
        test('accepts existing references', async () => {
            // ARRANGE
            const owner = await db.create('owners', { name: 'Ann' });
            const tag = await db.create('tags', { label: 'red' });

            // ACT
            const item = await db.create('items', {
                title: 'Lamp',
                ownerId: owner.id,
                tagIds: [tag.id],
            });

            // ASSERT
            expect(item).toMatchObject({ ownerId: owner.id, tagIds: [tag.id] });
        });

        test('accepts null and omitted references', async () => {
            // ACT
            const explicit = await db.create('items', {
                title: 'Null',
                ownerId: null,
                tagIds: [],
            });
            const omitted = await db.create('items', { title: 'Omitted' });

            // ASSERT
            expect(explicit).toMatchObject({ ownerId: null, tagIds: [] });
            expect(omitted).toMatchObject({ ownerId: null, tagIds: [] });
        });

        test('rejects a missing scalar target without writing the record', async () => {
            // ACT & ASSERT
            await expect(
                db.create('items', { title: 'Lamp', ownerId: uuidv7() })
            ).rejects.toMatchObject({
                code: 'REFERENCE_NOT_FOUND',
                status: 422,
            });
            expect(await recordFiles('items')).toEqual([]);
        });

        test('rejects ids that are not UUIDs', async () => {
            // ACT & ASSERT
            await expect(
                db.create('items', { title: 'Lamp', ownerId: 'nobody' })
            ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
        });

        test('rejects a missing array element', async () => {
            // ARRANGE
            const tag = await db.create('tags', { label: 'red' });

            // ACT & ASSERT
            await expect(
                db.create('items', {
                    title: 'Lamp',
                    tagIds: [tag.id, uuidv7()],
                })
            ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
        });

        test('rejects duplicate array references', async () => {
            // ARRANGE
            const tag = await db.create('tags', { label: 'red' });

            // ACT & ASSERT
            await expect(
                db.create('items', { title: 'Lamp', tagIds: [tag.id, tag.id] })
            ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });

        test('rejects a reference to another collection', async () => {
            // ARRANGE
            const tag = await db.create('tags', { label: 'red' });

            // ACT & ASSERT
            await expect(
                db.create('items', { title: 'Lamp', ownerId: tag.id })
            ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
        });

        test('schema validation still runs before reference checks', async () => {
            // ACT & ASSERT
            await expect(
                db.create('items', { ownerId: uuidv7() })
            ).rejects.toThrow('"title" is required.');
        });
    });

    describe('update', () => {
        let owner;
        let item;

        beforeEach(async () => {
            owner = await db.create('owners', { name: 'Ann' });
            item = await db.create('items', {
                title: 'Lamp',
                ownerId: owner.id,
            });
        });

        test('patching to another existing record works', async () => {
            // ARRANGE
            const other = await db.create('owners', { name: 'Bob' });

            // ACT
            const updated = await db.update('items', item.id, {
                ownerId: other.id,
            });

            // ASSERT
            expect(updated.ownerId).toBe(other.id);
            const byOld = await db.list('items', {
                where: { ownerId: owner.id },
            });
            expect(byOld.total).toBe(0);
        });

        test('patching to a missing record fails and keeps the record', async () => {
            // ACT & ASSERT
            await expect(
                db.update('items', item.id, { ownerId: uuidv7() })
            ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
            await expect(db.get('items', item.id)).resolves.toEqual(item);
        });

        test('patching unrelated fields keeps references', async () => {
            // ACT
            const updated = await db.update('items', item.id, {
                title: 'Desk lamp',
            });

            // ASSERT
            expect(updated.ownerId).toBe(owner.id);
        });

        test('references can be cleared with null', async () => {
            // ACT
            const updated = await db.update('items', item.id, {
                ownerId: null,
            });

            // ASSERT
            expect(updated.ownerId).toBeNull();
        });

        test('replace without a reference falls back to its default', async () => {
            // ACT
            const replaced = await db.update(
                'items',
                item.id,
                { title: 'New' },
                { replace: true }
            );

            // ASSERT
            expect(replaced).toEqual({
                id: item.id,
                title: 'New',
                ownerId: null,
                tagIds: [],
            });
        });

        test('replace validates references', async () => {
            // ACT & ASSERT
            await expect(
                db.update(
                    'items',
                    item.id,
                    { title: 'New', ownerId: uuidv7() },
                    { replace: true }
                )
            ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
        });
    });

    describe('delete', () => {
        test('setNull clears references and reports changes', async () => {
            // ARRANGE
            const owner = await db.create('owners', { name: 'Ann' });
            const a = await db.create('items', {
                title: 'A',
                ownerId: owner.id,
            });
            const b = await db.create('items', {
                title: 'B',
                ownerId: owner.id,
            });
            const c = await db.create('items', { title: 'C' });

            // ACT
            const report = await db.delete('owners', owner.id);

            // ASSERT
            expect(report.deleted).toEqual([
                { collection: 'owners', id: owner.id },
            ]);
            expect(report.updated).toEqual(
                expect.arrayContaining([
                    { collection: 'items', id: a.id, fields: ['ownerId'] },
                    { collection: 'items', id: b.id, fields: ['ownerId'] },
                ])
            );
            expect(report.updated).toHaveLength(2);
            expect((await db.get('items', a.id)).ownerId).toBeNull();
            expect((await db.get('items', b.id)).ownerId).toBeNull();
            await expect(db.get('items', c.id)).resolves.toEqual(c);
            const nulls = await db.list('items', { where: { ownerId: null } });
            expect(nulls.total).toBe(3);
        });

        test('remove pulls the id out of arrays and keeps other elements', async () => {
            // ARRANGE
            const red = await db.create('tags', { label: 'red' });
            const blue = await db.create('tags', { label: 'blue' });
            const item = await db.create('items', {
                title: 'A',
                tagIds: [red.id, blue.id],
            });

            // ACT
            const report = await db.delete('tags', red.id);

            // ASSERT
            expect(report.updated).toEqual([
                { collection: 'items', id: item.id, fields: ['tagIds'] },
            ]);
            expect((await db.get('items', item.id)).tagIds).toEqual([blue.id]);
        });

        test('restrict blocks the delete and changes nothing', async () => {
            // ARRANGE
            const owner = await db.create('owners', { name: 'Ann' });
            const item = await db.create('items', {
                title: 'A',
                ownerId: owner.id,
            });
            const note = await db.create('notes', {
                text: 'n',
                itemId: item.id,
            });

            // ACT & ASSERT
            await expect(db.delete('items', item.id)).rejects.toMatchObject({
                code: 'REFERENCE_RESTRICT',
                status: 409,
            });
            await expect(db.get('items', item.id)).resolves.toEqual(item);
            await expect(db.get('notes', note.id)).resolves.toEqual(note);
        });

        test('restrict allows the delete once referrers are gone', async () => {
            // ARRANGE
            const item = await db.create('items', { title: 'A' });
            const note = await db.create('notes', {
                text: 'n',
                itemId: item.id,
            });
            await db.delete('notes', note.id);

            // ACT & ASSERT
            await expect(db.delete('items', item.id)).resolves.toEqual({
                deleted: [{ collection: 'items', id: item.id }],
                updated: [],
            });
        });

        test('deleting a referencing record does not touch its targets', async () => {
            // ARRANGE
            const owner = await db.create('owners', { name: 'Ann' });
            const item = await db.create('items', {
                title: 'A',
                ownerId: owner.id,
            });

            // ACT
            await db.delete('items', item.id);

            // ASSERT
            await expect(db.get('owners', owner.id)).resolves.toEqual(owner);
        });

        test('self references: children are detached from a deleted parent', async () => {
            // ARRANGE
            const parent = await db.create('nodes', { label: 'root' });
            const child = await db.create('nodes', {
                label: 'child',
                parentId: parent.id,
            });

            // ACT
            const report = await db.delete('nodes', parent.id);

            // ASSERT
            expect(report.updated).toEqual([
                { collection: 'nodes', id: child.id, fields: ['parentId'] },
            ]);
            expect((await db.get('nodes', child.id)).parentId).toBeNull();
        });

        test('a record referencing itself can be deleted', async () => {
            // ARRANGE
            const node = await db.create('nodes', { label: 'loop' });
            await db.update('nodes', node.id, { parentId: node.id });

            // ACT & ASSERT
            await expect(db.delete('nodes', node.id)).resolves.toEqual({
                deleted: [{ collection: 'nodes', id: node.id }],
                updated: [],
            });
        });

        test('missing and invalid ids', async () => {
            // ACT & ASSERT
            await expect(db.delete('owners', uuidv7())).rejects.toMatchObject({
                code: 'NOT_FOUND',
            });
            await expect(db.delete('owners', 'nope')).rejects.toMatchObject({
                code: 'INVALID_ID',
            });
        });

        test('changes are persisted and pass the integrity check on reopen', async () => {
            // ARRANGE
            const owner = await db.create('owners', { name: 'Ann' });
            const tag = await db.create('tags', { label: 'red' });
            const item = await db.create('items', {
                title: 'A',
                ownerId: owner.id,
                tagIds: [tag.id],
            });
            await db.delete('owners', owner.id);
            await db.delete('tags', tag.id);

            // ACT
            const reopened = await openDatabase();

            // ASSERT
            await expect(reopened.get('items', item.id)).resolves.toEqual({
                ...item,
                ownerId: null,
                tagIds: [],
            });
        });
    });

    describe('concurrency', () => {
        test(
            'creates racing with a delete of their target never leave broken references',
            { repeats: 5 },
            async () => {
                // ARRANGE
                const owner = await db.create('owners', { name: 'Ann' });

                // ACT
                const results = await Promise.allSettled([
                    ...Array.from({ length: 5 }, (_, i) =>
                        db.create('items', {
                            title: `before-${i}`,
                            ownerId: owner.id,
                        })
                    ),
                    db.delete('owners', owner.id),
                    ...Array.from({ length: 5 }, (_, i) =>
                        db.create('items', {
                            title: `after-${i}`,
                            ownerId: owner.id,
                        })
                    ),
                ]);

                // ASSERT
                for (const result of results) {
                    if (result.status === 'rejected') {
                        expect(result.reason.code).toBe('REFERENCE_NOT_FOUND');
                    }
                }
                const items = await db.list('items');
                expect(items.items.every((i) => i.ownerId === null)).toBe(true);
                await expect(openDatabase()).resolves.toBeTruthy();
            }
        );

        test(
            'updates racing with a delete of their target never leave broken references',
            { repeats: 5 },
            async () => {
                // ARRANGE
                const owner = await db.create('owners', { name: 'Ann' });
                const items = [];
                for (let i = 0; i < 5; i++) {
                    items.push(await db.create('items', { title: `i${i}` }));
                }

                // ACT
                await Promise.allSettled([
                    ...items.map((item) =>
                        db.update('items', item.id, { ownerId: owner.id })
                    ),
                    db.delete('owners', owner.id),
                ]);

                // ASSERT
                await expect(db.get('owners', owner.id)).rejects.toMatchObject({
                    code: 'NOT_FOUND',
                });
                await expect(openDatabase()).resolves.toBeTruthy();
            }
        );

        test(
            'delete does not deadlock with referrers created and updated while it waits',
            { timeout: 10000 },
            async () => {
                // Regression: with per-record locks, a referrer created after delete()
                // computed its lock set and then updated to point at the target again
                // used to form a lock cycle. Writes are serialized by transactions now,
                // so delete must always succeed.
                for (let round = 0; round < 20; round++) {
                    const owner = await db.create('owners', { name: 'Ann' });
                    const writers = Array.from({ length: 6 }, async (_, i) => {
                        try {
                            const item = await db.create('items', {
                                title: `${i}`,
                                ownerId: owner.id,
                            });
                            await db.update('items', item.id, {
                                ownerId: owner.id,
                            });
                        } catch (error) {
                            expect(error.code).toBe('REFERENCE_NOT_FOUND');
                        }
                    });
                    const remover = db.delete('owners', owner.id);
                    await Promise.all([...writers, remover]);
                }

                await expect(openDatabase()).resolves.toBeTruthy();
            }
        );

        test('concurrent deletes of referenced records keep arrays consistent', async () => {
            // ARRANGE
            const tags = [];
            for (let i = 0; i < 5; i++) {
                tags.push(await db.create('tags', { label: `t${i}` }));
            }
            const item = await db.create('items', {
                title: 'A',
                tagIds: tags.map((t) => t.id),
            });

            // ACT
            await Promise.all(tags.map((t) => db.delete('tags', t.id)));

            // ASSERT
            expect((await db.get('items', item.id)).tagIds).toEqual([]);
            await expect(openDatabase()).resolves.toBeTruthy();
        });
    });
});
