import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { FileDatabase, eq } from '../../src/storage/file-database.js';
import { UnitOfWork } from '../../src/repositories/unit-of-work.js';
import { BaseRepository } from '../../src/repositories/base-repository.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
} from '../helpers/temp-db.js';

const OWNERS = {
    table: 'owners',
    primaryKey: 'id',
    timestamps: true,
    columns: {
        name: { type: 'string', required: true, unique: true },
        age: { type: 'integer', required: true, min: 0 },
        city: { type: 'string', default: 'Kyiv' },
    },
    indexes: ['age'],
};

const PETS = {
    table: 'pets',
    primaryKey: 'id',
    columns: {
        name: { type: 'string', required: true },
        ownerId: {
            type: 'string',
            nullable: true,
            default: null,
            references: { collection: 'owners', onDelete: 'setNull' },
        },
    },
    indexes: [],
};

/** A subclass with named queries, as real repositories have. */
class OwnerRepository extends BaseRepository {
    constructor(uow) {
        super(uow, 'owners');
    }

    findAdults() {
        return this.findAll({ where: { age: { gte: 18 } }, sort: 'name' });
    }

    findByAge(age) {
        return this.findAll({ predicate: eq('age', age) });
    }
}

const MISSING_ID = '01a16f8e-f7d3-752c-8a92-ece4658b47c1';

describe('BaseRepository', () => {
    let root;
    let db;
    let uow;
    let owners;
    let pets;

    async function open() {
        db = await new FileDatabase(root).init();
        uow = new UnitOfWork(db);
        owners = new OwnerRepository(uow);
        pets = new BaseRepository(uow, 'pets');
    }

    beforeEach(async () => {
        root = await createTempDir();
        await writeCollectionConfig(root, 'owners', OWNERS);
        await writeCollectionConfig(root, 'pets', PETS);
        await open();
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    test('knows its collection', () => {
        expect(owners.collection).toBe('owners');
        expect(pets.collection).toBe('pets');
    });

    describe('findById / getById', () => {
        let ann;

        beforeEach(async () => {
            ann = await owners.create({ name: 'Ann', age: 30 });
        });

        test('both return the stored record', async () => {
            await expect(owners.findById(ann.id)).resolves.toEqual(ann);
            await expect(owners.getById(ann.id)).resolves.toEqual(ann);
        });

        test('a missing record: findById gives null, getById 404', async () => {
            await expect(owners.findById(MISSING_ID)).resolves.toBeNull();
            await expect(owners.getById(MISSING_ID)).rejects.toMatchObject({
                code: 'NOT_FOUND',
                status: 404,
            });
        });

        test('a malformed id is a bad request for both, not a missing record', async () => {
            for (const find of [
                owners.findById('abc'),
                owners.getById('abc'),
            ]) {
                await expect(find).rejects.toMatchObject({
                    code: 'INVALID_ID',
                    status: 400,
                });
            }
        });

        test('findById does not hide other errors', async () => {
            // ARRANGE
            await db.close();

            // ACT & ASSERT
            await expect(owners.findById(ann.id)).rejects.toMatchObject({
                code: 'DATABASE_CLOSED',
            });
        });

        test('the record is a copy: changing it changes nothing stored', async () => {
            // ARRANGE
            const found = await owners.findById(ann.id);

            // ACT
            found.name = 'Changed';

            // ASSERT
            expect((await owners.getById(ann.id)).name).toBe('Ann');
        });
    });

    describe('create / update / replace', () => {
        test('create stores the record with an id, defaults and timestamps', async () => {
            // ACT
            const ann = await owners.create({ name: 'Ann', age: 30 });

            // ASSERT
            expect(ann).toEqual({
                id: expect.any(String),
                name: 'Ann',
                age: 30,
                city: 'Kyiv',
                createdAt: expect.any(String),
                updatedAt: expect.any(String),
            });
            await expect(owners.getById(ann.id)).resolves.toEqual(ann);
        });

        test('errors of the database pass through unchanged', async () => {
            // ARRANGE
            await owners.create({ name: 'Ann', age: 30 });

            // ACT & ASSERT
            await expect(owners.create({ name: 'Bob' })).rejects.toMatchObject({
                code: 'VALIDATION_ERROR',
                status: 422,
            });
            await expect(
                owners.create({ name: 'Ann', age: 40 })
            ).rejects.toMatchObject({ code: 'UNIQUE_VIOLATION', status: 409 });
            await expect(
                pets.create({ name: 'Rex', ownerId: MISSING_ID })
            ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
        });

        test('update changes only the given fields', async () => {
            // ARRANGE
            const ann = await owners.create({
                name: 'Ann',
                age: 30,
                city: 'Lviv',
            });

            // ACT
            const updated = await owners.update(ann.id, { age: 31 });

            // ASSERT
            expect(updated).toMatchObject({
                id: ann.id,
                name: 'Ann',
                age: 31,
                city: 'Lviv',
            });
            await expect(owners.getById(ann.id)).resolves.toEqual(updated);
        });

        test('replace resets fields that are not given to their defaults', async () => {
            // ARRANGE
            const ann = await owners.create({
                name: 'Ann',
                age: 30,
                city: 'Lviv',
            });

            // ACT
            const replaced = await owners.replace(ann.id, {
                name: 'Ann',
                age: 31,
            });

            // ASSERT
            expect(replaced).toMatchObject({
                id: ann.id,
                age: 31,
                city: 'Kyiv',
                createdAt: ann.createdAt,
            });
            await expect(
                owners.replace(ann.id, { age: 32 })
            ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });

        test('update and replace of a missing record are 404', async () => {
            await expect(
                owners.update(MISSING_ID, { age: 1 })
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await expect(
                owners.replace(MISSING_ID, { name: 'X', age: 1 })
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });
    });

    describe('delete', () => {
        test('removes the record and reports cleared references', async () => {
            // ARRANGE
            const ann = await owners.create({ name: 'Ann', age: 30 });
            const rex = await pets.create({ name: 'Rex', ownerId: ann.id });

            // ACT
            const report = await owners.delete(ann.id);

            // ASSERT
            expect(report).toEqual({
                deleted: [{ collection: 'owners', id: ann.id }],
                updated: [
                    { collection: 'pets', id: rex.id, fields: ['ownerId'] },
                ],
            });
            await expect(owners.findById(ann.id)).resolves.toBeNull();
            expect((await pets.getById(rex.id)).ownerId).toBeNull();
        });

        test('a missing record is 404', async () => {
            await expect(owners.delete(MISSING_ID)).rejects.toMatchObject({
                code: 'NOT_FOUND',
            });
        });
    });

    describe('findPage', () => {
        beforeEach(async () => {
            for (const [name, age] of [
                ['Ann', 30],
                ['Bob', 12],
                ['Cid', 45],
                ['Dan', 30],
            ]) {
                await owners.create({ name, age });
            }
        });

        test('passes where, sort, limit and offset through', async () => {
            // ACT
            const page = await owners.findPage({
                where: { age: { gte: 18 } },
                sort: '-name',
                limit: 2,
                offset: 1,
            });

            // ASSERT
            expect(page).toMatchObject({ total: 3, limit: 2, offset: 1 });
            expect(page.items.map((o) => o.name)).toEqual(['Cid', 'Ann']);
        });

        test('without a query returns the first page of everything', async () => {
            const page = await owners.findPage();
            expect(page).toMatchObject({ total: 4, limit: 100, offset: 0 });
        });

        test('ignores predicates: queries built in code belong to subclasses', async () => {
            const page = await owners.findPage({ predicate: eq('age', 12) });
            expect(page.total).toBe(4);
        });

        test('a wrong query is a 400', async () => {
            await expect(
                owners.findPage({ where: { color: 'red' } })
            ).rejects.toMatchObject({ code: 'INVALID_QUERY', status: 400 });
        });
    });

    describe('findAll', () => {
        test('subclasses use it with where, sort or a predicate', async () => {
            // ARRANGE
            for (const [name, age] of [
                ['Cid', 45],
                ['Bob', 12],
                ['Ann', 30],
            ]) {
                await owners.create({ name, age });
            }

            // ACT & ASSERT
            expect((await owners.findAdults()).map((o) => o.name)).toEqual([
                'Ann',
                'Cid',
            ]);
            expect((await owners.findByAge(12)).map((o) => o.name)).toEqual([
                'Bob',
            ]);
            await expect(owners.findByAge(99)).resolves.toEqual([]);
        });

        test('reads past the 500-record page limit', async () => {
            // ARRANGE: records written to disk before start, faster than 1203 commits
            await db.close();
            for (let i = 0; i < 1203; i++) {
                const id = uuidv7();
                await fs.writeFile(
                    path.join(root, 'owners', `${id}.json`),
                    JSON.stringify({
                        id,
                        name: `Owner ${String(i).padStart(4, '0')}`,
                        age: i % 2 === 0 ? 20 : 10,
                    })
                );
            }
            await open();

            // ACT
            const all = await owners.findAll();
            const adults = await owners.findAdults();

            // ASSERT
            expect(all).toHaveLength(1203);
            expect(new Set(all.map((o) => o.id)).size).toBe(1203);
            expect(adults).toHaveLength(602);
            expect(adults[0].name).toBe('Owner 0000');
            expect(adults.at(-1).name).toBe('Owner 1202');
        });
    });

    describe('inside a unit of work', () => {
        test('reads see the writes of the same unit', async () => {
            // ACT
            const seen = await uow.run(async () => {
                await owners.create({ name: 'Ann', age: 30 });
                return {
                    all: await owners.findAll(),
                    page: await owners.findPage(),
                };
            });

            // ASSERT
            expect(seen.all.map((o) => o.name)).toEqual(['Ann']);
            expect(seen.page.total).toBe(1);
        });

        test('a thrown error rolls back the writes of every repository', async () => {
            // ACT
            await expect(
                uow.run(async () => {
                    const ann = await owners.create({ name: 'Ann', age: 30 });
                    await pets.create({ name: 'Rex', ownerId: ann.id });
                    throw new Error('business rule');
                })
            ).rejects.toThrow('business rule');

            // ASSERT
            await expect(owners.findAll()).resolves.toEqual([]);
            await expect(pets.findAll()).resolves.toEqual([]);
        });

        test('findById can be used to branch without dooming the unit', async () => {
            // ACT
            const created = await uow.run(async () => {
                const existing = await owners.findById(MISSING_ID);
                return existing ?? owners.create({ name: 'Ann', age: 30 });
            });

            // ASSERT
            await expect(owners.getById(created.id)).resolves.toEqual(created);
        });
    });
});
