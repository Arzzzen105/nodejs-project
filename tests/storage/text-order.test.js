import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import {
    FileDatabase,
    gte,
    lt,
    range,
} from '../../src/storage/file-database.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
} from '../helpers/temp-db.js';

// Surnames whose first letters are out of alphabetical order by code point:
// Є, І, Ї come before А, and Ґ after Я
const SURNAMES = [
    'Андрієнко',
    'Бондар',
    'Гнатюк',
    'Ґудзенко',
    'Дорошенко',
    'Єременко',
    'Жук',
    'Іваненко',
    'Їжак',
    'Коваль',
    'Шевченко',
    'Яковенко',
];

const KIDS = {
    table: 'kids',
    primaryKey: 'id',
    columns: {
        lastName: { type: 'string', required: true },
        indexedName: { type: 'string', required: true },
    },
    indexes: ['indexedName'],
};

describe('ranges over text follow the sort order', () => {
    let root;
    let db;

    beforeEach(async () => {
        root = await createTempDir();
        await writeCollectionConfig(root, 'kids', KIDS);
        db = await new FileDatabase(root).init();
        // stored in reverse, so the result never depends on creation order
        for (const name of [...SURNAMES].reverse()) {
            await db.create('kids', { lastName: name, indexedName: name });
        }
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    const names = (result, field) =>
        result.items.map((kid) => kid[field]).sort();

    test('sorting puts Ukrainian letters in alphabetical order', async () => {
        const sorted = await db.list('kids', { sort: 'lastName' });
        expect(sorted.items.map((kid) => kid.lastName)).toEqual(SURNAMES);
    });

    describe.each(['lastName', 'indexedName'])('on %s', (field) => {
        test.each(['Б', 'Ґ', 'Д', 'Є', 'І', 'Ї', 'Ш', 'Ґудзенко', 'Іваненко'])(
            'a range up to or from %s is a slice of the sorted list',
            async (bound) => {
                // ARRANGE
                const sorted = (
                    await db.list('kids', { sort: field })
                ).items.map((kid) => kid[field]);
                const split = sorted.findIndex(
                    (name) => name.localeCompare(bound, 'uk') >= 0
                );
                const before = split === -1 ? sorted : sorted.slice(0, split);
                const after = split === -1 ? [] : sorted.slice(split);

                // ACT
                const below = await db.list('kids', {
                    predicate: lt(field, bound),
                });
                const from = await db.list('kids', {
                    where: { [field]: { gte: bound } },
                });

                // ASSERT
                expect(names(below, field)).toEqual([...before].sort());
                expect(names(from, field)).toEqual([...after].sort());
            }
        );

        test('Ґудзенко lies between Г and Д, Іваненко between И and Й', async () => {
            const betweenGandD = await db.list('kids', {
                predicate: range(field, { gte: 'Г', lt: 'Д' }),
                sort: field,
            });
            expect(betweenGandD.items.map((kid) => kid[field])).toEqual([
                'Гнатюк',
                'Ґудзенко',
            ]);
            const fromI = await db.list('kids', {
                where: { [field]: { gte: 'І', lt: 'Й' } },
                sort: field,
            });
            expect(fromI.items.map((kid) => kid[field])).toEqual([
                'Іваненко',
                'Їжак',
            ]);
        });

        test('records changed in a transaction are compared the same way', async () => {
            const result = await db.transaction(async (tx) => {
                await tx.create('kids', {
                    lastName: 'Ґонта',
                    indexedName: 'Ґонта',
                });
                return tx.list('kids', {
                    predicate: lt(field, 'Д'),
                    sort: field,
                });
            });
            expect(result.items.map((kid) => kid[field])).toEqual([
                'Андрієнко',
                'Бондар',
                'Гнатюк',
                'Ґонта',
                'Ґудзенко',
            ]);
        });
    });

    test('ids are still compared by code point', async () => {
        const ids = (await db.list('kids', { sort: 'id' })).items.map(
            (kid) => kid.id
        );
        const result = await db.list('kids', { predicate: gte('id', ids[5]) });
        expect(result.items.map((kid) => kid.id).sort()).toEqual(ids.slice(5));
    });
});
