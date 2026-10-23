import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { FileDatabase } from '../../src/storage/file-database.js';
import { Journal } from '../../src/storage/journal.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
} from '../helpers/temp-db.js';

function collectionConfig(name, columns) {
    return { table: name, primaryKey: 'id', columns, indexes: [] };
}

const CONFIGS = {
    owners: collectionConfig('owners', {
        name: { type: 'string', required: true },
    }),
    items: collectionConfig('items', {
        title: { type: 'string', required: true },
        ownerId: {
            type: 'string',
            nullable: true,
            default: null,
            references: { collection: 'owners', onDelete: 'setNull' },
        },
    }),
    payments: collectionConfig('payments', {
        amount: { type: 'integer', required: true, min: 1 },
        itemId: {
            type: 'string',
            required: true,
            references: { collection: 'items' },
        },
    }),
};

function deferred() {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('db.transaction', () => {
    let root;
    let db;

    async function openDatabase() {
        return new FileDatabase(root).init();
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

    test('commits related records atomically and persists them', async () => {
        // ACT
        const { owner, item, payment } = await db.transaction(async (tx) => {
            const owner = await tx.create('owners', { name: 'Ann' });
            const item = await tx.create('items', {
                title: 'Lamp',
                ownerId: owner.id,
            });
            const payment = await tx.create('payments', {
                amount: 100,
                itemId: item.id,
            });
            return { owner, item, payment };
        });

        // ASSERT
        const reopened = await openDatabase();
        await expect(reopened.get('owners', owner.id)).resolves.toEqual(owner);
        await expect(reopened.get('items', item.id)).resolves.toEqual(item);
        await expect(reopened.get('payments', payment.id)).resolves.toEqual(
            payment
        );
    });

    test('a failure in the middle leaves no partial changes', async () => {
        // ACT
        await expect(
            db.transaction(async (tx) => {
                const owner = await tx.create('owners', { name: 'Ann' });
                const item = await tx.create('items', {
                    title: 'Lamp',
                    ownerId: owner.id,
                });
                // invalid amount: the whole transaction must be discarded
                await tx.create('payments', { amount: 0, itemId: item.id });
            })
        ).rejects.toThrow('"amount" must be at least 1.');

        // ASSERT
        for (const name of Object.keys(CONFIGS)) {
            expect((await db.list(name)).total).toBe(0);
        }
    });

    test('rollback returns a value and discards changes', async () => {
        // ACT
        const result = await db.transaction(async (tx) => {
            await tx.create('owners', { name: 'Ann' });
            return tx.rollback({ reason: 'dry run' });
        });

        // ASSERT
        expect(result).toEqual({ reason: 'dry run' });
        expect((await db.list('owners')).total).toBe(0);
    });

    test('a delete with setNull inside a transaction is committed as a whole', async () => {
        // ARRANGE
        const owner = await db.create('owners', { name: 'Ann' });
        const a = await db.create('items', { title: 'A', ownerId: owner.id });
        const b = await db.create('items', { title: 'B', ownerId: owner.id });

        // ACT
        const report = await db.transaction((tx) =>
            tx.delete('owners', owner.id)
        );

        // ASSERT
        expect(report.updated).toHaveLength(2);
        expect((await db.get('items', a.id)).ownerId).toBeNull();
        expect((await db.get('items', b.id)).ownerId).toBeNull();
        await expect(openDatabase()).resolves.toBeTruthy();
    });

    test('plain db.delete with setNull is one journaled commit', async () => {
        // ARRANGE
        const owner = await db.create('owners', { name: 'Ann' });
        const a = await db.create('items', { title: 'A', ownerId: owner.id });
        const b = await db.create('items', { title: 'B', ownerId: owner.id });
        const write = vi.spyOn(Journal.prototype, 'write');

        try {
            // ACT
            await db.delete('owners', owner.id);

            // ASSERT: referrers and the record itself in a single journal entry
            expect(write).toHaveBeenCalledTimes(1);
            expect(write.mock.calls[0][0]).toEqual([
                {
                    collection: 'items',
                    id: a.id,
                    record: { ...a, ownerId: null },
                },
                {
                    collection: 'items',
                    id: b.id,
                    record: { ...b, ownerId: null },
                },
                { collection: 'owners', id: owner.id, record: null },
            ]);
        } finally {
            write.mockRestore();
        }
    });

    test('plain single-record writes are journaled too', async () => {
        // ARRANGE
        const write = vi.spyOn(Journal.prototype, 'write');

        try {
            // ACT
            const owner = await db.create('owners', { name: 'Ann' });
            await db.update('owners', owner.id, { name: 'Bob' });
            await db.delete('owners', owner.id);

            // ASSERT
            expect(write).toHaveBeenCalledTimes(3);
        } finally {
            write.mockRestore();
        }
    });

    test('restrict inside a transaction rejects it', async () => {
        // ARRANGE
        const item = await db.create('items', { title: 'Lamp' });
        await db.create('payments', { amount: 5, itemId: item.id });

        // ACT & ASSERT
        await expect(
            db.transaction((tx) => tx.delete('items', item.id))
        ).rejects.toMatchObject({ code: 'REFERENCE_RESTRICT' });
        await expect(db.get('items', item.id)).resolves.toEqual(item);
    });

    describe('using the database directly inside a transaction', () => {
        test.each([
            ['get', (db) => db.get('owners', uuidv7())],
            ['list', (db) => db.list('owners')],
            ['create', (db) => db.create('owners', { name: 'x' })],
            ['update', (db) => db.update('owners', uuidv7(), {})],
            ['delete', (db) => db.delete('owners', uuidv7())],
            ['transaction', (db) => db.transaction(async () => {})],
        ])('db.%s() throws INVALID_TRANSACTION_USE', async (method, call) => {
            // ACT & ASSERT
            await expect(
                db.transaction(async () => {
                    await call(db);
                })
            ).rejects.toMatchObject({
                code: 'INVALID_TRANSACTION_USE',
                message: expect.stringContaining(`tx.${method}`),
            });
        });

        test('metadata methods stay available', async () => {
            // ACT & ASSERT
            await expect(
                db.transaction(async () => [
                    db.collections().length,
                    Object.keys(db.schema('owners').columns),
                ])
            ).resolves.toEqual([3, ['name']]);
        });

        test('the database is usable again after the transaction', async () => {
            // ARRANGE
            await db.transaction(async (tx) =>
                tx.create('owners', { name: 'Ann' })
            );

            // ACT & ASSERT
            expect((await db.list('owners')).total).toBe(1);
        });
    });

    describe('isolation from plain operations', () => {
        test('plain writes wait for a running transaction', async () => {
            // ARRANGE
            const gate = deferred();
            const events = [];
            const running = db.transaction(async (tx) => {
                await tx.create('owners', { name: 'In transaction' });
                await gate.promise;
                events.push('transaction');
            });
            await tick();

            // ACT
            const plain = db
                .create('owners', { name: 'Plain' })
                .then(() => events.push('plain'));
            await tick();

            // ASSERT
            expect(events).toEqual([]);
            gate.resolve();
            await Promise.all([running, plain]);
            expect(events).toEqual(['transaction', 'plain']);
        });

        test('plain reads see only committed data', async () => {
            // ARRANGE
            const gate = deferred();
            const running = db.transaction(async (tx) => {
                await tx.create('owners', { name: 'Uncommitted' });
                await gate.promise;
            });
            await tick();

            // ACT
            const during = await db.list('owners');

            // ASSERT
            expect(during.total).toBe(0);
            gate.resolve();
            await running;
            expect((await db.list('owners')).total).toBe(1);
        });

        test('a transaction does not see plain writes queued after it', async () => {
            // ARRANGE
            const gate = deferred();
            let seenInside;
            const running = db.transaction(async (tx) => {
                await gate.promise;
                seenInside = (await tx.list('owners')).total;
            });
            const plain = db.create('owners', { name: 'Later' });
            await tick();

            // ACT
            gate.resolve();
            await Promise.all([running, plain]);

            // ASSERT
            expect(seenInside).toBe(0);
            expect((await db.list('owners')).total).toBe(1);
        });
    });
});
