import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import { FileDatabase, contains } from '../../src/storage/file-database.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
} from '../helpers/temp-db.js';

const KIDS = {
    table: 'kids',
    primaryKey: 'id',
    columns: {
        name: { type: 'string', required: true },
        // plain arrays: one indexed by element, one not
        tags: { type: 'array', default: [] },
        labels: { type: 'array', default: [] },
    },
    indexes: ['tags'],
};

const PARENTS = {
    table: 'parents',
    primaryKey: 'id',
    columns: {
        name: { type: 'string', required: true },
        // reference arrays get an element index automatically
        childIds: {
            type: 'array',
            default: [],
            items: { references: { collection: 'kids', onDelete: 'remove' } },
        },
    },
    indexes: [],
};

describe('contains', () => {
    let root;
    let db;
    let ann;
    let bob;

    const names = (result) => result.items.map((record) => record.name).sort();

    beforeEach(async () => {
        root = await createTempDir();
        await writeCollectionConfig(root, 'kids', KIDS);
        await writeCollectionConfig(root, 'parents', PARENTS);
        db = await new FileDatabase(root).init();
        ann = await db.create('kids', {
            name: 'Ann',
            tags: ['speech', 'allergy'],
            labels: ['a'],
        });
        bob = await db.create('kids', { name: 'Bob', tags: ['allergy'] });
        await db.create('parents', {
            name: 'Olha',
            childIds: [ann.id, bob.id],
        });
        await db.create('parents', { name: 'Petro', childIds: [ann.id] });
        await db.create('parents', { name: 'Iryna' });
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    test('finds parents of a kid through a reference array', async () => {
        const parents = await db.list('parents', {
            predicate: contains('childIds', bob.id),
        });
        expect(names(parents)).toEqual(['Olha']);
        const viaWhere = await db.list('parents', {
            where: { childIds: { contains: ann.id } },
        });
        expect(names(viaWhere)).toEqual(['Olha', 'Petro']);
    });

    test('indexed and unindexed plain arrays give the same answers', async () => {
        expect(
            names(
                await db.list('kids', {
                    predicate: contains('tags', 'allergy'),
                })
            )
        ).toEqual(['Ann', 'Bob']);
        expect(
            names(
                await db.list('kids', { where: { labels: { contains: 'a' } } })
            )
        ).toEqual(['Ann']);
    });

    test('the element index is rebuilt on start', async () => {
        await db.close();
        db = await new FileDatabase(root).init();
        expect(
            names(
                await db.list('kids', { predicate: contains('tags', 'speech') })
            )
        ).toEqual(['Ann']);
    });

    test('follows updates and removed references', async () => {
        await db.update('kids', bob.id, { tags: ['speech'] });
        expect(
            names(
                await db.list('kids', {
                    predicate: contains('tags', 'allergy'),
                })
            )
        ).toEqual(['Ann']);

        await db.delete('kids', ann.id);
        expect(
            names(
                await db.list('parents', {
                    predicate: contains('childIds', ann.id),
                })
            )
        ).toEqual([]);
    });

    test('a transaction sees its own changes', async () => {
        const result = await db.transaction(async (tx) => {
            const iryna = (
                await tx.list('parents', { where: { name: 'Iryna' } })
            ).items[0];
            await tx.update('parents', iryna.id, { childIds: [bob.id] });
            const petro = (
                await tx.list('parents', { where: { name: 'Petro' } })
            ).items[0];
            await tx.update('parents', petro.id, { childIds: [] });
            return {
                ofBob: await tx.list('parents', {
                    predicate: contains('childIds', bob.id),
                }),
                ofAnn: await tx.list('parents', {
                    where: { childIds: { contains: ann.id } },
                }),
            };
        });
        expect(names(result.ofBob)).toEqual(['Iryna', 'Olha']);
        expect(names(result.ofAnn)).toEqual(['Olha']);
    });

    test('a wrong query is a 400', async () => {
        await expect(
            db.list('kids', { where: { name: { contains: 'A' } } })
        ).rejects.toMatchObject({ code: 'INVALID_QUERY', status: 400 });
        await expect(
            db.list('parents', { predicate: contains('childIds', 1) })
        ).rejects.toMatchObject({ code: 'INVALID_QUERY', status: 400 });
    });
});
