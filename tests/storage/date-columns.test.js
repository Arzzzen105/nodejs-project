import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import {
    FileDatabase,
    and,
    eq,
    gt,
    gte,
    inList,
    ne,
    or,
    range,
} from '../../src/storage/file-database.js';
import { validateConfig } from '../../src/storage/validator.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
} from '../helpers/temp-db.js';
import { createTestLogger } from '../helpers/test-logger.js';

const KIDS = {
    table: 'kids',
    primaryKey: 'id',
    columns: {
        name: { type: 'string', required: true },
        birthDate: {
            type: 'date',
            required: true,
            min: '2019-01-01',
            max: '2026-12-31',
        },
        enrolledAt: { type: 'datetime', nullable: true, default: null },
        badgeDate: { type: 'date', nullable: true, unique: true },
    },
    indexes: ['birthDate'],
};

describe('date and datetime columns', () => {
    let root;
    let db;
    let logger;

    async function open() {
        db = new FileDatabase(root, { logger });
        await db.init();
    }

    beforeEach(async () => {
        root = await createTempDir();
        await writeCollectionConfig(root, 'kids', KIDS);
        logger = createTestLogger();
        await open();
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    describe('date', () => {
        test('stores calendar dates as they are', async () => {
            const kid = await db.create('kids', {
                name: 'Оля',
                birthDate: '2022-03-14',
            });
            expect(kid.birthDate).toBe('2022-03-14');
            expect((await db.get('kids', kid.id)).birthDate).toBe('2022-03-14');
        });

        test.each([
            ['a day that does not exist', '2023-02-29', /must be date/],
            [
                'a moment instead of a date',
                '2022-03-14T00:00:00Z',
                /must be date/,
            ],
            ['before min', '2018-12-31', /must be at least 2019-01-01/],
            ['after max', '2027-01-01', /must be at most 2026-12-31/],
        ])('rejects %s', async (_label, birthDate, message) => {
            await expect(
                db.create('kids', { name: 'X', birthDate })
            ).rejects.toThrow(message);
        });
    });

    describe('datetime', () => {
        test('stores moments in canonical UTC form', async () => {
            const kid = await db.create('kids', {
                name: 'Оля',
                birthDate: '2022-03-14',
                enrolledAt: '2026-09-01T08:30+03:00',
            });
            expect(kid.enrolledAt).toBe('2026-09-01T05:30:00.000Z');
            const onDisk = JSON.parse(
                await fs.readFile(
                    path.join(root, 'kids', `${kid.id}.json`),
                    'utf8'
                )
            );
            expect(onDisk.enrolledAt).toBe('2026-09-01T05:30:00.000Z');
        });

        test('rejects moments without an offset', async () => {
            await expect(
                db.create('kids', {
                    name: 'X',
                    birthDate: '2022-03-14',
                    enrolledAt: '2026-09-01T08:30:00',
                })
            ).rejects.toThrow(
                '"enrolledAt" must be datetime (ISO 8601 with an offset, e.g. 2026-10-23T12:00:00+03:00).'
            );
        });

        test('update normalizes as well', async () => {
            const kid = await db.create('kids', {
                name: 'Оля',
                birthDate: '2022-03-14',
            });
            const updated = await db.update('kids', kid.id, {
                enrolledAt: '2026-09-01T12:00:00.5-04:00',
            });
            expect(updated.enrolledAt).toBe('2026-09-01T16:00:00.500Z');
        });
    });

    describe('queries', () => {
        let kids;

        beforeEach(async () => {
            kids = [];
            for (const [name, birthDate, enrolledAt] of [
                ['A', '2021-09-01', '2026-09-01T06:00:00Z'],
                ['B', '2022-08-31', '2026-09-01T05:59:59.999Z'],
                ['C', '2022-09-01', null],
                ['D', '2020-01-15', '2025-09-01T06:00:00Z'],
            ]) {
                kids.push(
                    await db.create('kids', { name, birthDate, enrolledAt })
                );
            }
        });

        const names = (result) => result.items.map((k) => k.name);

        test('date ranges, e.g. born in one school year', async () => {
            const result = await db.list('kids', {
                where: { birthDate: { gte: '2021-09-01', lt: '2022-09-01' } },
                sort: 'birthDate',
            });
            expect(names(result)).toEqual(['A', 'B']);
        });

        test('datetime filters are normalized before comparing', async () => {
            // 09:00 in Kyiv (+03:00) is 06:00 UTC
            const result = await db.list('kids', {
                where: { enrolledAt: { gte: '2026-09-01T09:00+03:00' } },
            });
            expect(names(result)).toEqual(['A']);
            const exact = await db.list('kids', {
                where: { enrolledAt: '2026-09-01T09:00:00+03:00' },
            });
            expect(names(exact)).toEqual(['A']);
            const listed = await db.list('kids', {
                where: { enrolledAt: { in: ['2026-09-01T09:00+03:00'] } },
            });
            expect(names(listed)).toEqual(['A']);
        });

        test('sorting follows time, nulls last', async () => {
            expect(names(await db.list('kids', { sort: 'birthDate' }))).toEqual(
                ['D', 'A', 'B', 'C']
            );
            expect(
                names(await db.list('kids', { sort: '-enrolledAt' }))
            ).toEqual(['A', 'B', 'D', 'C']);
        });

        test('predicates take canonical strings', async () => {
            const result = await db.list('kids', {
                predicate: gte(
                    'enrolledAt',
                    new Date('2026-01-01').toISOString()
                ),
            });
            expect(names(result)).toEqual(['A', 'B']);
        });

        test('regression: predicates normalize datetime values like where does', async () => {
            // A's enrolledAt is 06:00 UTC = 09:00 in Kyiv
            const kyiv = '2026-09-01T09:00+03:00';
            const cases = [
                [eq('enrolledAt', kyiv), { enrolledAt: kyiv }],
                [ne('enrolledAt', kyiv), { enrolledAt: { ne: kyiv } }],
                [
                    gt('enrolledAt', '2026-09-01T08:59+03:00'),
                    { enrolledAt: { gt: '2026-09-01T08:59+03:00' } },
                ],
                [inList('enrolledAt', [kyiv]), { enrolledAt: { in: [kyiv] } }],
                [
                    range('enrolledAt', {
                        gte: kyiv,
                        lt: '2026-09-02T00:00+03:00',
                    }),
                    { enrolledAt: { gte: kyiv, lt: '2026-09-02T00:00+03:00' } },
                ],
            ];
            for (const [predicate, where] of cases) {
                const byPredicate = names(await db.list('kids', { predicate }));
                const byWhere = names(await db.list('kids', { where }));
                expect(byPredicate).toEqual(byWhere);
            }
            expect(
                names(
                    await db.list('kids', { predicate: eq('enrolledAt', kyiv) })
                )
            ).toEqual(['A']);
        });

        test('nested predicates are normalized too, and stay reusable', async () => {
            const predicate = or(
                and(
                    eq('name', 'A'),
                    eq('enrolledAt', '2026-09-01T09:00+03:00')
                ),
                eq('name', 'C')
            );
            expect(names(await db.list('kids', { predicate }))).toEqual([
                'A',
                'C',
            ]);
            // the original predicate keeps its values, so it can be used again
            expect(predicate.predicates[0].predicates[1].value).toBe(
                '2026-09-01T09:00+03:00'
            );
            expect(names(await db.list('kids', { predicate }))).toEqual([
                'A',
                'C',
            ]);
        });

        test('predicates with an invalid datetime are a bad request', async () => {
            await expect(
                db.list('kids', { predicate: gte('enrolledAt', '2026-09-01') })
            ).rejects.toMatchObject({
                code: 'INVALID_QUERY',
                status: 400,
                message: expect.stringContaining('+03:00'),
            });
        });

        test('predicates on other columns are left as they are', async () => {
            expect(
                names(
                    await db.list('kids', {
                        predicate: eq('birthDate', '2021-09-01'),
                    })
                )
            ).toEqual(['A']);
        });

        test('invalid filter values are rejected', async () => {
            await expect(
                db.list('kids', { where: { birthDate: { gte: '2021-13-01' } } })
            ).rejects.toMatchObject({
                code: 'INVALID_QUERY',
                status: 400,
                message: expect.stringContaining('YYYY-MM-DD'),
            });
        });
    });

    test('unique works for dates', async () => {
        await db.create('kids', {
            name: 'A',
            birthDate: '2022-01-01',
            badgeDate: '2026-09-01',
        });
        await expect(
            db.create('kids', {
                name: 'B',
                birthDate: '2022-01-01',
                badgeDate: '2026-09-01',
            })
        ).rejects.toMatchObject({ code: 'UNIQUE_VIOLATION' });
    });

    test('a stored datetime out of canonical form is reported and fixed by PATCH', async () => {
        // ARRANGE: a hand-edited file
        await db.close();
        const id = uuidv7();
        await fs.writeFile(
            path.join(root, 'kids', `${id}.json`),
            JSON.stringify({
                id,
                name: 'Edited',
                birthDate: '2022-03-14',
                enrolledAt: '2026-09-01T08:30:00+03:00',
            })
        );

        // ACT
        await open();

        // ASSERT
        expect(db.warnings).toEqual([
            {
                code: 'INVALID_RECORD',
                collection: 'kids',
                id,
                message:
                    '"enrolledAt" is not stored in the canonical UTC form.',
            },
        ]);
        const fixed = await db.update('kids', id, { name: 'Fixed' });
        expect(fixed.enrolledAt).toBe('2026-09-01T05:30:00.000Z');
    });
});

describe('date and datetime in config', () => {
    const withColumn = (definition) => ({
        table: 'items',
        primaryKey: 'id',
        columns: { field: definition },
        indexes: [],
    });

    test.each([
        { type: 'date', min: '2020-01-01', max: '2020-12-31' },
        { type: 'datetime', min: '2020-01-01T00:00:00+02:00' },
        { type: 'date', default: '2026-09-01', enum: ['2026-09-01'] },
        { type: 'datetime', unique: true },
        // as strings min > max, but as moments 02:00 UTC is before 03:00 UTC
        {
            type: 'datetime',
            min: '2020-01-01T05:00:00+03:00',
            max: '2020-01-01T03:00:00Z',
        },
    ])('accepts %j', (definition) => {
        expect(() =>
            validateConfig('items', withColumn(definition))
        ).not.toThrow();
    });

    test.each([
        [{ type: 'date', min: 20200101 }, /"min" must be a valid date/],
        [
            { type: 'datetime', max: '2020-01-01' },
            /"max" must be a valid datetime/,
        ],
        [
            { type: 'date', min: '2021-01-01', max: '2020-01-01' },
            /must not be greater/,
        ],
        [
            // as strings min < max, but 05:00+03:00 is 02:00 UTC, before 03:00 UTC
            {
                type: 'datetime',
                min: '2020-01-01T03:00:00Z',
                max: '2020-01-01T05:00:00+03:00',
            },
            /must not be greater/,
        ],
        [{ type: 'date', default: '2026-02-30' }, /Invalid default/],
        [{ type: 'date', minLength: 10 }, /requires a string column/],
        [
            { type: 'datetime', enum: ['2026-01-01T00:00:00.000Z'] },
            /"enum" is not supported for datetime columns/,
        ],
        [
            { type: 'string', min: '2020-01-01' },
            /requires a numeric, date or datetime column/,
        ],
    ])('rejects %j', (definition, message) => {
        expect(() => validateConfig('items', withColumn(definition))).toThrow(
            message
        );
    });
});
