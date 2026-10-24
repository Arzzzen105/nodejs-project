import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { FileDatabase, gt } from '../../src/storage/file-database.js';
import { validateConfig } from '../../src/storage/validator.js';
import { isDatetime, normalizeDatetime } from '../../src/storage/dates.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
} from '../helpers/temp-db.js';
import { createTestLogger } from '../helpers/test-logger.js';

const config = (name, columns, extra = {}) => ({
    table: name,
    primaryKey: 'id',
    columns,
    indexes: [],
    ...extra,
});

const PAYMENTS = config(
    'payments',
    {
        amount: { type: 'integer', required: true, min: 1 },
        ownerId: {
            type: 'string',
            nullable: true,
            default: null,
            references: { collection: 'owners', onDelete: 'setNull' },
        },
    },
    { timestamps: true, indexes: ['updatedAt'] }
);
const OWNERS = config('owners', { name: { type: 'string', required: true } });

const tick = () => new Promise((r) => setTimeout(r, 5));
const isCanonical = (value) =>
    isDatetime(value) && normalizeDatetime(value) === value;

describe('timestamps', () => {
    let root;
    let db;

    async function open() {
        db = new FileDatabase(root, { logger: createTestLogger() });
        await db.init();
    }

    beforeEach(async () => {
        root = await createTempDir();
        await writeCollectionConfig(root, 'payments', PAYMENTS);
        await writeCollectionConfig(root, 'owners', OWNERS);
        await open();
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    test('create sets createdAt and updatedAt to now', async () => {
        const before = new Date().toISOString();
        const payment = await db.create('payments', { amount: 100 });
        const after = new Date().toISOString();

        expect(isCanonical(payment.createdAt)).toBe(true);
        expect(payment.updatedAt).toBe(payment.createdAt);
        expect(payment.createdAt >= before && payment.createdAt <= after).toBe(
            true
        );
    });

    test('collections without timestamps get none', async () => {
        const owner = await db.create('owners', { name: 'Ann' });
        expect(owner).not.toHaveProperty('createdAt');
        expect(owner).not.toHaveProperty('updatedAt');
    });

    test('PATCH and PUT keep createdAt and move updatedAt', async () => {
        const payment = await db.create('payments', { amount: 100 });
        await tick();

        const patched = await db.update('payments', payment.id, {
            amount: 200,
        });
        expect(patched.createdAt).toBe(payment.createdAt);
        expect(patched.updatedAt > payment.updatedAt).toBe(true);

        await tick();
        const replaced = await db.update(
            'payments',
            payment.id,
            { amount: 300 },
            { replace: true }
        );
        expect(replaced.createdAt).toBe(payment.createdAt);
        expect(replaced.updatedAt > patched.updatedAt).toBe(true);
    });

    test('setNull on delete counts as an update', async () => {
        const owner = await db.create('owners', { name: 'Ann' });
        const payment = await db.create('payments', {
            amount: 100,
            ownerId: owner.id,
        });
        await tick();

        await db.delete('owners', owner.id);

        const updated = await db.get('payments', payment.id);
        expect(updated.ownerId).toBeNull();
        expect(updated.updatedAt > payment.updatedAt).toBe(true);
    });

    test.each(['createdAt', 'updatedAt'])(
        'clients cannot set %s',
        async (field) => {
            const value = new Date().toISOString();
            await expect(
                db.create('payments', { amount: 1, [field]: value })
            ).rejects.toMatchObject({
                code: 'VALIDATION_ERROR',
                message: `The "${field}" field is managed by the database.`,
            });
            const payment = await db.create('payments', { amount: 1 });
            await expect(
                db.update('payments', payment.id, { [field]: value })
            ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        }
    );

    test('timestamps can be filtered and sorted', async () => {
        const first = await db.create('payments', { amount: 1 });
        await tick();
        const second = await db.create('payments', { amount: 2 });
        await tick();
        await db.update('payments', first.id, { amount: 3 });

        const bySort = await db.list('payments', { sort: '-updatedAt' });
        expect(bySort.items.map((p) => p.id)).toEqual([first.id, second.id]);

        const since = await db.list('payments', {
            where: { createdAt: { gt: first.createdAt } },
        });
        expect(since.items.map((p) => p.id)).toEqual([second.id]);

        const byPredicate = await db.list('payments', {
            predicate: gt('createdAt', first.createdAt),
        });
        expect(byPredicate.items.map((p) => p.id)).toEqual([second.id]);
    });

    test('changes inside one transaction share the transaction view', async () => {
        const result = await db.transaction(async (tx) => {
            const created = await tx.create('payments', { amount: 1 });
            const listed = await tx.list('payments', {
                where: { createdAt: created.createdAt },
            });
            return { created, listed };
        });
        expect(result.listed.items).toEqual([result.created]);
    });

    describe('records stored before timestamps were turned on', () => {
        const createdAt = '2025-03-14T08:00:00.000Z';
        let id;

        beforeEach(async () => {
            await db.close();
            // a UUIDv7 carries the moment it was generated
            id = uuidv7({ msecs: Date.parse(createdAt) });
            await fs.writeFile(
                path.join(root, 'payments', `${id}.json`),
                JSON.stringify({ id, amount: 5, ownerId: null })
            );
            await open();
        });

        test('load without warnings', () => {
            expect(db.warnings).toEqual([]);
        });

        test('get createdAt from their id on the first change', async () => {
            const updated = await db.update('payments', id, { amount: 6 });
            expect(updated.createdAt).toBe(createdAt);
            expect(updated.updatedAt > createdAt).toBe(true);
            expect(isCanonical(updated.updatedAt)).toBe(true);
        });

        test('an update without changes sets updatedAt to createdAt', async () => {
            const updated = await db.update('payments', id, {});
            expect(updated.createdAt).toBe(createdAt);
            expect(updated.updatedAt).toBe(createdAt);
        });
    });

    test('updatedAt moves only when the record really changes', async () => {
        const payment = await db.create('payments', { amount: 100 });
        await tick();

        const empty = await db.update('payments', payment.id, {});
        const same = await db.update('payments', payment.id, { amount: 100 });
        expect(empty.updatedAt).toBe(payment.updatedAt);
        expect(same.updatedAt).toBe(payment.updatedAt);

        const changed = await db.update('payments', payment.id, {
            amount: 101,
        });
        expect(changed.updatedAt > payment.updatedAt).toBe(true);
    });

    test('a broken stored timestamp is reported', async () => {
        await db.close();
        const id = uuidv7();
        await fs.writeFile(
            path.join(root, 'payments', `${id}.json`),
            JSON.stringify({ id, amount: 5, createdAt: 'yesterday' })
        );
        await open();

        expect(db.warnings).toEqual([
            expect.objectContaining({
                code: 'INVALID_RECORD',
                id,
                message:
                    '"createdAt" must be a datetime in the canonical UTC form.',
            }),
        ]);
    });

    test('schema() returns the config as written', () => {
        expect(db.schema('payments')).toEqual(PAYMENTS);
    });
});

describe('timestamps in config', () => {
    test('must be a boolean', () => {
        expect(() =>
            validateConfig('items', config('items', {}, { timestamps: 'yes' }))
        ).toThrow(/"timestamps" of "items" must be a boolean/);
    });

    test.each(['createdAt', 'updatedAt'])(
        'cannot be combined with a declared %s column',
        (column) => {
            expect(() =>
                validateConfig(
                    'items',
                    config(
                        'items',
                        { [column]: { type: 'datetime' } },
                        { timestamps: true }
                    )
                )
            ).toThrow(/is managed by the database/);
        }
    );

    test('timestamp columns may be indexed only when timestamps are on', () => {
        expect(() =>
            validateConfig(
                'items',
                config(
                    'items',
                    {},
                    { timestamps: true, indexes: ['createdAt'] }
                )
            )
        ).not.toThrow();
        expect(() =>
            validateConfig(
                'items',
                config('items', {}, { indexes: ['createdAt'] })
            )
        ).toThrow(/Invalid index/);
    });

    test('without timestamps createdAt is an ordinary column name', () => {
        expect(() =>
            validateConfig(
                'items',
                config('items', { createdAt: { type: 'datetime' } })
            )
        ).not.toThrow();
    });
});
