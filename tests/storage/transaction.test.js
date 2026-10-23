import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { Collection } from '../../src/storage/collection.js';
import { DatabaseError, DatabaseErrors } from '../../src/storage/errors.js';
import { RelationManager } from '../../src/storage/relation-manager.js';
import { Transaction } from '../../src/storage/transaction.js';
import { and, eq, gt, or } from '../../src/storage/predicate.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
    insert,
} from '../helpers/temp-db.js';

function collectionConfig(name, columns, indexes = []) {
    return { table: name, primaryKey: 'id', columns, indexes };
}

const CONFIGS = {
    owners: collectionConfig(
        'owners',
        {
            name: { type: 'string', required: true },
            age: { type: 'integer' },
        },
        ['name']
    ),
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
};

describe('Transaction', () => {
    let root;
    let collections;
    let relations;
    let snapshot;

    /** Committed collections, used to prepare data outside of transactions. */
    const base = (name) => collections.get(name);

    function begin() {
        return new Transaction({
            collection: (name) => {
                const collection = collections.get(name);
                if (!collection) {
                    throw new DatabaseError(
                        DatabaseErrors.COLLECTION_NOT_FOUND,
                        `Unknown collection "${name}".`
                    );
                }
                return collection;
            },
            relations,
        });
    }

    async function diskState() {
        const state = {};
        for (const name of Object.keys(CONFIGS)) {
            state[name] = (await fs.readdir(path.join(root, name))).sort();
        }
        return state;
    }

    beforeEach(async () => {
        root = await createTempDir();
        collections = new Map();
        for (const [name, config] of Object.entries(CONFIGS)) {
            const directory = await writeCollectionConfig(root, name, config);
            const collection = new Collection(name, directory, config);
            await collection.loadRecords();
            collections.set(name, collection);
        }
        relations = new RelationManager(new Map(Object.entries(CONFIGS)));
        snapshot = null;
    });

    afterEach(async () => {
        // no test may write through a transaction
        if (snapshot) expect(await diskState()).toEqual(snapshot);
        await removeDir(root);
    });

    /** Freezes the current disk state; afterEach verifies it did not change. */
    async function freezeDisk() {
        snapshot = await diskState();
    }

    describe('create', () => {
        test('the new record is visible inside the transaction only', async () => {
            // ARRANGE
            await freezeDisk();
            const tx = begin();

            // ACT
            const owner = await tx.create('owners', { name: 'Ann' });

            // ASSERT
            await expect(tx.get('owners', owner.id)).resolves.toEqual(owner);
            expect(base('owners').has(owner.id)).toBe(false);
        });

        test('may reference a record created earlier in the same transaction', async () => {
            // ARRANGE
            await freezeDisk();
            const tx = begin();
            const owner = await tx.create('owners', { name: 'Ann' });

            // ACT
            const item = await tx.create('items', {
                title: 'Lamp',
                ownerId: owner.id,
            });

            // ASSERT
            expect(item.ownerId).toBe(owner.id);
        });

        test('rejects references to missing records', async () => {
            // ARRANGE
            const tx = begin();

            // ACT & ASSERT
            await expect(
                tx.create('items', { title: 'Lamp', ownerId: uuidv7() })
            ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
        });

        test('rejects references to records deleted in the transaction', async () => {
            // ARRANGE
            const owner = await insert(base('owners'), { name: 'Ann' });
            const tx = begin();
            await tx.delete('owners', owner.id);

            // ACT & ASSERT
            await expect(
                tx.create('items', { title: 'Lamp', ownerId: owner.id })
            ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
        });

        test('validates the schema', async () => {
            // ARRANGE
            const tx = begin();

            // ACT & ASSERT
            await expect(tx.create('owners', {})).rejects.toThrow(
                '"name" is required.'
            );
            await expect(
                tx.create('owners', { id: uuidv7(), name: 'x' })
            ).rejects.toThrow('The "id" field is generated by the server.');
        });

        test('rejects unknown collections', async () => {
            // ARRANGE
            const tx = begin();

            // ACT & ASSERT
            await expect(tx.create('ghosts', {})).rejects.toMatchObject({
                code: 'COLLECTION_NOT_FOUND',
            });
        });
    });

    describe('get', () => {
        test('reads committed records', async () => {
            // ARRANGE
            const owner = await insert(base('owners'), { name: 'Ann' });

            // ACT & ASSERT
            await expect(begin().get('owners', owner.id)).resolves.toEqual(
                owner
            );
        });

        test('missing and invalid ids', async () => {
            // ARRANGE
            const tx = begin();

            // ACT & ASSERT
            await expect(tx.get('owners', uuidv7())).rejects.toMatchObject({
                code: 'NOT_FOUND',
            });
            await expect(tx.get('owners', 'nope')).rejects.toMatchObject({
                code: 'INVALID_ID',
            });
        });

        test('returned records are copies', async () => {
            // ARRANGE
            const tx = begin();
            const owner = await tx.create('owners', { name: 'Ann' });

            // ACT
            owner.name = 'Mutated';
            (await tx.get('owners', owner.id)).name = 'Mutated again';

            // ASSERT
            expect((await tx.get('owners', owner.id)).name).toBe('Ann');
        });
    });

    describe('update', () => {
        test('changes are visible in the transaction, committed record stays', async () => {
            // ARRANGE
            const owner = await insert(base('owners'), { name: 'Ann' });
            await freezeDisk();
            const tx = begin();

            // ACT
            const updated = await tx.update('owners', owner.id, { age: 30 });

            // ASSERT
            expect(updated).toEqual({ ...owner, age: 30 });
            await expect(tx.get('owners', owner.id)).resolves.toEqual(updated);
            await expect(base('owners').get(owner.id)).resolves.toEqual(owner);
        });

        test('updates a record created in the same transaction', async () => {
            // ARRANGE
            const tx = begin();
            const owner = await tx.create('owners', { name: 'Ann' });

            // ACT
            await tx.update('owners', owner.id, { name: 'Bob' });

            // ASSERT
            expect((await tx.get('owners', owner.id)).name).toBe('Bob');
        });

        test('replace uses the transaction version as previous record', async () => {
            // ARRANGE
            const tx = begin();
            const owner = await tx.create('owners', { name: 'Ann', age: 3 });

            // ACT
            const replaced = await tx.update(
                'owners',
                owner.id,
                { name: 'Bob' },
                { replace: true }
            );

            // ASSERT
            expect(replaced).toEqual({ id: owner.id, name: 'Bob' });
        });

        test('validates body before existence, then existence', async () => {
            // ARRANGE
            const tx = begin();

            // ACT & ASSERT
            await expect(
                tx.update('owners', uuidv7(), null)
            ).rejects.toMatchObject({ code: 'INVALID_BODY' });
            await expect(
                tx.update('owners', uuidv7(), { name: 'x' })
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await expect(
                tx.update('owners', 'nope', { name: 'x' })
            ).rejects.toMatchObject({ code: 'INVALID_ID' });
        });

        test('cannot update a record deleted in the transaction', async () => {
            // ARRANGE
            const owner = await insert(base('owners'), { name: 'Ann' });
            const tx = begin();
            await tx.delete('owners', owner.id);

            // ACT & ASSERT
            await expect(
                tx.update('owners', owner.id, { name: 'x' })
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });

        test('validates references', async () => {
            // ARRANGE
            const item = await insert(base('items'), { title: 'Lamp' });
            const tx = begin();

            // ACT & ASSERT
            await expect(
                tx.update('items', item.id, { ownerId: uuidv7() })
            ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
        });

        test('a failed update leaves the transaction version unchanged', async () => {
            // ARRANGE
            const tx = begin();
            const owner = await tx.create('owners', { name: 'Ann' });

            // ACT
            await tx.update('owners', owner.id, { age: 'old' }).catch(() => {});

            // ASSERT
            await expect(tx.get('owners', owner.id)).resolves.toEqual(owner);
        });
    });

    describe('delete', () => {
        test('the record disappears inside the transaction only', async () => {
            // ARRANGE
            const owner = await insert(base('owners'), { name: 'Ann' });
            await freezeDisk();
            const tx = begin();

            // ACT
            const report = await tx.delete('owners', owner.id);

            // ASSERT
            expect(report).toEqual({
                deleted: [{ collection: 'owners', id: owner.id }],
                updated: [],
            });
            await expect(tx.get('owners', owner.id)).rejects.toMatchObject({
                code: 'NOT_FOUND',
            });
            expect(base('owners').has(owner.id)).toBe(true);
        });

        test('missing records and double deletes', async () => {
            // ARRANGE
            const owner = await insert(base('owners'), { name: 'Ann' });
            const tx = begin();
            await tx.delete('owners', owner.id);

            // ACT & ASSERT
            await expect(tx.delete('owners', owner.id)).rejects.toMatchObject({
                code: 'NOT_FOUND',
            });
            await expect(tx.delete('owners', uuidv7())).rejects.toMatchObject({
                code: 'NOT_FOUND',
            });
        });

        test('setNull applies to committed and new referrers', async () => {
            // ARRANGE
            const owner = await insert(base('owners'), { name: 'Ann' });
            const committed = await insert(base('items'), {
                title: 'Old',
                ownerId: owner.id,
            });
            await freezeDisk();
            const tx = begin();
            const fresh = await tx.create('items', {
                title: 'New',
                ownerId: owner.id,
            });

            // ACT
            const report = await tx.delete('owners', owner.id);

            // ASSERT
            expect(report.updated).toEqual(
                expect.arrayContaining([
                    {
                        collection: 'items',
                        id: committed.id,
                        fields: ['ownerId'],
                    },
                    { collection: 'items', id: fresh.id, fields: ['ownerId'] },
                ])
            );
            expect((await tx.get('items', committed.id)).ownerId).toBeNull();
            expect((await tx.get('items', fresh.id)).ownerId).toBeNull();
            expect((await base('items').get(committed.id)).ownerId).toBe(
                owner.id
            );
        });

        test('key scenario: create owner, reference it, delete it', async () => {
            // ARRANGE
            const tx = begin();
            const owner = await tx.create('owners', { name: 'Ann' });
            const item = await tx.create('items', {
                title: 'Lamp',
                ownerId: owner.id,
            });

            // ACT
            await tx.delete('owners', owner.id);

            // ASSERT
            expect((await tx.get('items', item.id)).ownerId).toBeNull();
            expect(tx.changes()).toEqual([
                {
                    collection: 'items',
                    id: item.id,
                    record: { ...item, ownerId: null },
                },
            ]);
        });

        test('remove pulls the id out of arrays', async () => {
            // ARRANGE
            const red = await insert(base('tags'), { label: 'red' });
            const blue = await insert(base('tags'), { label: 'blue' });
            const item = await insert(base('items'), {
                title: 'Lamp',
                tagIds: [red.id, blue.id],
            });
            const tx = begin();

            // ACT
            await tx.delete('tags', red.id);

            // ASSERT
            expect((await tx.get('items', item.id)).tagIds).toEqual([blue.id]);
        });

        test('restrict is checked against the transaction view', async () => {
            // ARRANGE
            const item = await insert(base('items'), { title: 'Lamp' });
            const note = await insert(base('notes'), {
                text: 'n',
                itemId: item.id,
            });
            const tx = begin();

            // ACT & ASSERT: blocked by a committed referrer
            await expect(tx.delete('items', item.id)).rejects.toMatchObject({
                code: 'REFERENCE_RESTRICT',
            });

            // ACT & ASSERT: allowed once the referrer is deleted in the transaction
            await tx.delete('notes', note.id);
            await expect(tx.delete('items', item.id)).resolves.toBeTruthy();
        });

        test('restrict also sees referrers created in the transaction', async () => {
            // ARRANGE
            const item = await insert(base('items'), { title: 'Lamp' });
            const tx = begin();
            await tx.create('notes', { text: 'n', itemId: item.id });

            // ACT & ASSERT
            await expect(tx.delete('items', item.id)).rejects.toMatchObject({
                code: 'REFERENCE_RESTRICT',
            });
        });

        test('referrers moved away in the transaction are not touched', async () => {
            // ARRANGE
            const ann = await insert(base('owners'), { name: 'Ann' });
            const bob = await insert(base('owners'), { name: 'Bob' });
            const item = await insert(base('items'), {
                title: 'Lamp',
                ownerId: ann.id,
            });
            const tx = begin();
            await tx.update('items', item.id, { ownerId: bob.id });

            // ACT
            const report = await tx.delete('owners', ann.id);

            // ASSERT
            expect(report.updated).toEqual([]);
            expect((await tx.get('items', item.id)).ownerId).toBe(bob.id);
        });

        test('a blocked delete changes nothing', async () => {
            // ARRANGE
            const owner = await insert(base('owners'), { name: 'Ann' });
            const item = await insert(base('items'), {
                title: 'Lamp',
                ownerId: owner.id,
            });
            await insert(base('notes'), { text: 'n', itemId: item.id });
            const tx = begin();

            // ACT
            await tx.delete('items', item.id).catch(() => {});

            // ASSERT
            expect(tx.changes()).toEqual([]);
        });
    });

    describe('list', () => {
        let ann;
        let bob;

        beforeEach(async () => {
            ann = await insert(base('owners'), { name: 'Ann', age: 30 });
            bob = await insert(base('owners'), { name: 'Bob', age: 40 });
        });

        const ids = (result) => result.items.map((r) => r.id);

        test('includes created and excludes deleted records', async () => {
            // ARRANGE
            const tx = begin();
            const cid = await tx.create('owners', { name: 'Cid', age: 50 });
            await tx.delete('owners', ann.id);

            // ACT
            const result = await tx.list('owners');

            // ASSERT
            expect(ids(result)).toEqual([bob.id, cid.id]);
            expect(result.total).toBe(2);
        });

        test('indexed filters see changed values', async () => {
            // ARRANGE
            const tx = begin();
            await tx.update('owners', ann.id, { name: 'Anna' });
            const fresh = await tx.create('owners', { name: 'Ann' });

            // ACT
            const byOld = await tx.list('owners', { where: { name: 'Ann' } });
            const byNew = await tx.list('owners', { where: { name: 'Anna' } });
            const byIn = await tx.list('owners', {
                where: { name: { in: ['Anna', 'Bob'] } },
            });
            const byRange = await tx.list('owners', {
                where: { name: { gte: 'Anna' } },
            });

            // ASSERT
            expect(ids(byOld)).toEqual([fresh.id]);
            expect(ids(byNew)).toEqual([ann.id]);
            expect(ids(byIn)).toEqual([ann.id, bob.id]);
            expect(ids(byRange)).toEqual([ann.id, bob.id]);
        });

        test('unindexed filters read records through the transaction', async () => {
            // ARRANGE
            const tx = begin();
            await tx.update('owners', bob.id, { age: 20 });

            // ACT
            const result = await tx.list('owners', {
                where: { age: { gt: 25 } },
            });

            // ASSERT
            expect(ids(result)).toEqual([ann.id]);
        });

        test('predicates and id filters work on the transaction view', async () => {
            // ARRANGE
            const tx = begin();
            const cid = await tx.create('owners', { name: 'Cid', age: 50 });

            // ACT
            const composite = await tx.list('owners', {
                predicate: or(
                    eq('name', 'Cid'),
                    and(eq('name', 'Ann'), gt('age', 1))
                ),
            });
            const byId = await tx.list('owners', {
                where: { id: { in: [cid.id, bob.id] } },
            });

            // ASSERT
            expect(ids(composite)).toEqual([ann.id, cid.id]);
            expect(ids(byId)).toEqual([bob.id, cid.id]);
        });

        test('reference filters see changed references', async () => {
            // ARRANGE
            const item = await insert(base('items'), {
                title: 'Lamp',
                ownerId: ann.id,
            });
            const tx = begin();
            await tx.update('items', item.id, { ownerId: bob.id });

            // ACT
            const byAnn = await tx.list('items', {
                where: { ownerId: ann.id },
            });
            const byBob = await tx.list('items', {
                where: { ownerId: bob.id },
            });

            // ASSERT
            expect(byAnn.total).toBe(0);
            expect(ids(byBob)).toEqual([item.id]);
        });

        test('pagination works over the combined view', async () => {
            // ARRANGE
            const tx = begin();
            const cid = await tx.create('owners', { name: 'Cid' });

            // ACT
            const page = await tx.list('owners', { limit: 1, offset: 2 });

            // ASSERT
            expect(page.total).toBe(3);
            expect(ids(page)).toEqual([cid.id]);
        });

        test('validates query options', async () => {
            // ACT & ASSERT
            await expect(
                begin().list('owners', { limit: 0 })
            ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
        });
    });

    describe('changes', () => {
        test('an empty transaction has no changes', () => {
            expect(begin().changes()).toEqual([]);
        });

        test('keeps only the final state of every record', async () => {
            // ARRANGE
            const owner = await insert(base('owners'), { name: 'Ann' });
            const tx = begin();

            // ACT
            const created = await tx.create('owners', { name: 'Bob' });
            await tx.update('owners', created.id, { age: 1 });
            await tx.update('owners', created.id, { age: 2 });
            await tx.update('owners', owner.id, { age: 3 });

            // ASSERT
            expect(tx.changes()).toEqual([
                {
                    collection: 'owners',
                    id: created.id,
                    record: { ...created, age: 2 },
                },
                {
                    collection: 'owners',
                    id: owner.id,
                    record: { ...owner, age: 3 },
                },
            ]);
        });

        test('lists puts before deletes', async () => {
            // ARRANGE
            const doomed = await insert(base('owners'), { name: 'Ann' });
            const tx = begin();

            // ACT
            await tx.delete('owners', doomed.id);
            const created = await tx.create('owners', { name: 'Bob' });

            // ASSERT
            expect(tx.changes().map((c) => c.id)).toEqual([
                created.id,
                doomed.id,
            ]);
            expect(tx.changes()[1].record).toBeNull();
        });

        test('a record created and deleted in the transaction leaves no change', async () => {
            // ARRANGE
            const tx = begin();
            const temp = await tx.create('owners', { name: 'Temp' });

            // ACT
            await tx.delete('owners', temp.id);

            // ASSERT
            expect(tx.changes()).toEqual([]);
        });

        test('changes are copies', async () => {
            // ARRANGE
            const tx = begin();
            const owner = await tx.create('owners', { name: 'Ann' });

            // ACT
            tx.changes()[0].record.name = 'Mutated';

            // ASSERT
            expect((await tx.get('owners', owner.id)).name).toBe('Ann');
        });
    });

    describe('operation ordering', () => {
        test('concurrently started operations run in call order', async () => {
            // ARRANGE
            const owner = await insert(base('owners'), { name: 'Ann' });
            const tx = begin();

            // ACT: delete is called first, so the create must see the owner gone
            const [deleted, created] = await Promise.allSettled([
                tx.delete('owners', owner.id),
                tx.create('items', { title: 'Lamp', ownerId: owner.id }),
            ]);

            // ASSERT
            expect(deleted.status).toBe('fulfilled');
            expect(created.reason.code).toBe('REFERENCE_NOT_FOUND');
        });

        test('reverse call order: the new referrer is nulled by the delete', async () => {
            // ARRANGE
            const owner = await insert(base('owners'), { name: 'Ann' });
            const tx = begin();

            // ACT
            const [created] = await Promise.all([
                tx.create('items', { title: 'Lamp', ownerId: owner.id }),
                tx.delete('owners', owner.id),
            ]);

            // ASSERT
            expect((await tx.get('items', created.id)).ownerId).toBeNull();
        });

        test('a create cannot slip in while a delete awaits disk reads', async () => {
            // ARRANGE: delete has to read a committed referrer from disk,
            // which gives an unserialized create a chance to run in between
            const owner = await insert(base('owners'), { name: 'Ann' });
            await insert(base('items'), { title: 'Old', ownerId: owner.id });
            const tx = begin();

            // ACT
            const [deleted, created] = await Promise.allSettled([
                tx.delete('owners', owner.id),
                tx.create('items', { title: 'New', ownerId: owner.id }),
            ]);

            // ASSERT
            expect(deleted.status).toBe('fulfilled');
            expect(created.reason?.code).toBe('REFERENCE_NOT_FOUND');
            const dangling = tx
                .changes()
                .filter((c) => c.record?.ownerId === owner.id);
            expect(dangling).toEqual([]);
        });

        test('a failed operation does not block the next ones', async () => {
            // ARRANGE
            const tx = begin();

            // ACT
            const results = await Promise.allSettled([
                tx.create('owners', {}),
                tx.create('owners', { name: 'Ann' }),
            ]);

            // ASSERT
            expect(results.map((r) => r.status)).toEqual([
                'rejected',
                'fulfilled',
            ]);
        });
    });
});
