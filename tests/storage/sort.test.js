import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import { FileDatabase } from '../../src/storage/file-database.js';
import { compareRecords, parseSort } from '../../src/storage/sort.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
} from '../helpers/temp-db.js';

const COLUMNS = {
    name: { type: 'string' },
    age: { type: 'integer' },
    active: { type: 'boolean' },
    meta: { type: 'object' },
    tags: { type: 'array' },
};

describe('parseSort', () => {
    test('no sort means the default order', () => {
        expect(parseSort(undefined, COLUMNS)).toEqual([]);
        expect(parseSort(null, COLUMNS)).toEqual([]);
    });

    test('parses fields, directions and lists', () => {
        expect(parseSort('name', COLUMNS)).toEqual([
            { field: 'name', direction: 1 },
        ]);
        expect(parseSort('-age, name', COLUMNS)).toEqual([
            { field: 'age', direction: -1 },
            { field: 'name', direction: 1 },
        ]);
        expect(parseSort(['active', '-id'], COLUMNS)).toEqual([
            { field: 'active', direction: 1 },
            { field: 'id', direction: -1 },
        ]);
    });

    test.each([
        ['unknown field', 'color', /Unknown sort field "color"/],
        ['object column', 'meta', /Cannot sort by "meta" \(object\)/],
        ['array column', '-tags', /Cannot sort by "tags" \(array\)/],
        ['empty field', 'name,', /empty field/],
        ['lonely minus', '-', /empty field/],
        ['repeated field', 'name,-name', /"name" is repeated/],
        ['non-string', 5, /must be a string or an array of strings/],
        ['array with non-strings', ['name', 1], /must be a string/],
    ])('rejects %s', (_label, sort, message) => {
        expect(() => parseSort(sort, COLUMNS)).toThrow(
            expect.objectContaining({
                code: 'INVALID_QUERY',
                status: 400,
                message: expect.stringMatching(message),
            })
        );
    });
});

describe('compareRecords', () => {
    const sortBy = (records, sort) =>
        [...records]
            .sort((a, b) => compareRecords(a, b, parseSort(sort, COLUMNS)))
            .map((r) => r.id);

    test('strings follow Ukrainian collation and compare digits as numbers', () => {
        const records = [
            { id: '1', name: 'Яна' },
            { id: '2', name: 'Ґанна' },
            { id: '3', name: 'Галина' },
            { id: '4', name: 'Група 10' },
            { id: '5', name: 'Група 2' },
        ];
        // Ukrainian alphabet: Г, Ґ, ... Я; code point order would put Ґ after Я
        expect(sortBy(records, 'name')).toEqual(['3', '5', '4', '2', '1']);
    });

    test('numbers and booleans', () => {
        const records = [
            { id: '1', age: 10, active: true },
            { id: '2', age: 2, active: false },
            { id: '3', age: -1, active: true },
        ];
        expect(sortBy(records, 'age')).toEqual(['3', '2', '1']);
        expect(sortBy(records, '-age')).toEqual(['1', '2', '3']);
        expect(sortBy(records, 'active')).toEqual(['2', '1', '3']);
    });

    test('null and missing values are last in both directions', () => {
        const records = [
            { id: '1', age: null },
            { id: '2', age: 5 },
            { id: '3' },
            { id: '4', age: 1 },
        ];
        expect(sortBy(records, 'age')).toEqual(['4', '2', '1', '3']);
        expect(sortBy(records, '-age')).toEqual(['2', '4', '1', '3']);
    });

    test('ties are broken by id, also for later keys', () => {
        const records = [
            { id: 'c', name: 'Ann', age: 1 },
            { id: 'a', name: 'Ann', age: 1 },
            { id: 'b', name: 'Ann', age: 0 },
        ];
        expect(sortBy(records, 'name')).toEqual(['a', 'b', 'c']);
        expect(sortBy(records, 'name,age')).toEqual(['b', 'a', 'c']);
    });

    test('ids compare as plain strings, not as numbers', () => {
        const records = [{ id: 'x10' }, { id: 'x9' }, { id: 'x100' }];
        expect(sortBy(records, 'id')).toEqual(['x10', 'x100', 'x9']);
        expect(sortBy(records, '-id')).toEqual(['x9', 'x100', 'x10']);
    });

    test('values of another type are ordered by type', () => {
        const records = [
            { id: '1', age: 'old' },
            { id: '2', age: 3 },
            { id: '3', age: true },
        ];
        expect(sortBy(records, 'age')).toEqual(['2', '1', '3']);
    });
});

describe('sorting in list', () => {
    let root;
    let db;
    let kids;

    beforeEach(async () => {
        root = await createTempDir();
        await writeCollectionConfig(root, 'kids', {
            table: 'kids',
            primaryKey: 'id',
            columns: {
                lastName: { type: 'string', required: true },
                age: { type: 'integer', nullable: true },
            },
            indexes: ['lastName'],
        });
        db = await new FileDatabase(root).init();
        kids = [];
        for (const [lastName, age] of [
            ['Шевченко', 4],
            ['Бойко', 3],
            ['Шевченко', 2],
            ['Ґудзь', null],
            ['Антоненко', 5],
        ]) {
            kids.push(await db.create('kids', { lastName, age }));
        }
    });

    afterEach(async () => {
        await db.close();
        await removeDir(root);
    });

    const names = (result) => result.items.map((k) => `${k.lastName} ${k.age}`);

    test('without sort records come in creation order', async () => {
        const result = await db.list('kids');
        expect(result.items.map((k) => k.id)).toEqual(kids.map((k) => k.id));
    });

    test('sorts by several keys', async () => {
        expect(names(await db.list('kids', { sort: 'lastName,-age' }))).toEqual(
            ['Антоненко 5', 'Бойко 3', 'Ґудзь null', 'Шевченко 4', 'Шевченко 2']
        );
    });

    test('nulls are last and -id reverses creation order', async () => {
        expect(names(await db.list('kids', { sort: '-age' })).at(-1)).toBe(
            'Ґудзь null'
        );
        const reversed = await db.list('kids', { sort: '-id' });
        expect(reversed.items.map((k) => k.id)).toEqual(
            kids.map((k) => k.id).reverse()
        );
    });

    test('pagination walks the sorted order without gaps or overlaps', async () => {
        const pages = [];
        for (let offset = 0; offset < 5; offset += 2) {
            const page = await db.list('kids', {
                sort: 'lastName',
                limit: 2,
                offset,
            });
            pages.push(...page.items.map((k) => k.id));
            expect(page.total).toBe(5);
        }
        const all = await db.list('kids', { sort: 'lastName' });
        expect(pages).toEqual(all.items.map((k) => k.id));
    });

    test('sorting combines with filters', async () => {
        const result = await db.list('kids', {
            where: { lastName: 'Шевченко' },
            sort: 'age',
        });
        expect(names(result)).toEqual(['Шевченко 2', 'Шевченко 4']);
    });

    test('transactions sort their own uncommitted changes', async () => {
        const sorted = await db.transaction(async (tx) => {
            await tx.create('kids', { lastName: 'Абрамович', age: 1 });
            await tx.update('kids', kids[1].id, { lastName: 'Яковенко' });
            return names(await tx.list('kids', { sort: 'lastName' }));
        });
        expect(sorted[0]).toBe('Абрамович 1');
        expect(sorted.at(-1)).toBe('Яковенко 3');
    });

    test('invalid sort is a 400', async () => {
        await expect(db.list('kids', { sort: 'height' })).rejects.toMatchObject(
            { code: 'INVALID_QUERY', status: 400 }
        );
    });

    test('null options mean defaults', async () => {
        await expect(db.list('kids', null)).resolves.toMatchObject({
            total: 5,
        });
    });
});
