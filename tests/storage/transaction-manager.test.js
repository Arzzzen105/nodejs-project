import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import { Collection } from '../../src/storage/collection.js';
import { Journal } from '../../src/storage/journal.js';
import { RelationManager } from '../../src/storage/relation-manager.js';
import { TransactionManager } from '../../src/storage/transaction-manager.js';
import { FileDatabase } from '../../src/storage/file-database.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
    fileExists,
} from '../helpers/temp-db.js';

const OWNERS = {
    table: 'owners',
    primaryKey: 'id',
    columns: { name: { type: 'string', required: true } },
    indexes: [],
};

function deferred() {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('TransactionManager', () => {
    let root;
    let owners;
    let journal;
    let manager;

    beforeEach(async () => {
        root = await createTempDir();
        const directory = await writeCollectionConfig(root, 'owners', OWNERS);
        owners = new Collection('owners', directory, OWNERS);
        await owners.loadRecords();
        journal = new Journal(root);
        manager = new TransactionManager({
            journal,
            collection: () => owners,
            relations: new RelationManager(new Map([['owners', OWNERS]])),
        });
    });

    afterEach(async () => {
        await removeDir(root);
    });

    describe('commit', () => {
        test('applies changes and resolves with the body result', async () => {
            // ACT
            const result = await manager.run(async (tx) => {
                const a = await tx.create('owners', { name: 'Ann' });
                const b = await tx.create('owners', { name: 'Bob' });
                return [a, b];
            });

            // ASSERT
            expect(result).toHaveLength(2);
            for (const record of result) {
                await expect(owners.get(record.id)).resolves.toEqual(record);
            }
            expect(await fileExists(journal.path)).toBe(false);
        });

        test('writes the journal before touching record files', async () => {
            // ARRANGE
            const order = [];
            const write = journal.write.bind(journal);
            journal.write = async (changes) => {
                order.push('journal');
                await write(changes);
            };
            const applyPut = owners.applyPut.bind(owners);
            owners.applyPut = async (record) => {
                order.push(
                    (await fileExists(journal.path))
                        ? 'apply'
                        : 'apply:no-journal'
                );
                await applyPut(record);
            };

            // ACT
            await manager.run(async (tx) => {
                await tx.create('owners', { name: 'Ann' });
                await tx.create('owners', { name: 'Bob' });
            });

            // ASSERT
            expect(order).toEqual(['journal', 'apply', 'apply']);
        });

        test('a single change is applied without a journal', async () => {
            // ARRANGE
            let written = false;
            journal.write = async () => {
                written = true;
            };

            // ACT
            const owner = await manager.run((tx) =>
                tx.create('owners', { name: 'Ann' })
            );

            // ASSERT
            expect(written).toBe(false);
            await expect(owners.get(owner.id)).resolves.toEqual(owner);
        });

        test('a failed single change is reported without blocking the database', async () => {
            // ARRANGE
            const applyPut = owners.applyPut.bind(owners);
            owners.applyPut = async () => {
                throw new Error('disk full');
            };

            // ACT & ASSERT
            await expect(
                manager.run((tx) => tx.create('owners', { name: 'Ann' }))
            ).rejects.toThrow('disk full');

            owners.applyPut = applyPut;
            await expect(
                manager.run((tx) => tx.create('owners', { name: 'Bob' }))
            ).resolves.toMatchObject({ name: 'Bob' });
        });

        test('an empty transaction does not write a journal', async () => {
            // ARRANGE
            let written = false;
            journal.write = async () => {
                written = true;
            };

            // ACT
            await manager.run(async (tx) => tx.list('owners'));

            // ASSERT
            expect(written).toBe(false);
        });

        test('operations the body did not await are committed too', async () => {
            // ARRANGE: an update has to read the record from disk first
            const owner = await owners.create({ name: 'Ann' });

            // ACT
            await manager.run(async (tx) => {
                tx.update('owners', owner.id, { name: 'Forgotten await' });
            });

            // ASSERT
            expect((await owners.get(owner.id)).name).toBe('Forgotten await');
        });
    });

    describe('rollback and errors', () => {
        test('rollback(value) discards changes and resolves with value', async () => {
            // ACT
            const result = await manager.run(async (tx) => {
                await tx.create('owners', { name: 'Ann' });
                tx.rollback('cancelled');
                await tx.create('owners', { name: 'Never' });
            });

            // ASSERT
            expect(result).toBe('cancelled');
            expect(owners.records.size).toBe(0);
        });

        test('rollback without a value resolves with undefined', async () => {
            // ACT & ASSERT
            await expect(manager.run((tx) => tx.rollback())).resolves.toBe(
                undefined
            );
        });

        test('a rollback swallowed by the body still rolls back', async () => {
            // ACT
            const result = await manager.run(async (tx) => {
                await tx.create('owners', { name: 'Ann' });
                try {
                    tx.rollback('swallowed');
                } catch {
                    // careless catch-all in user code
                }
                return 'normal result';
            });

            // ASSERT
            expect(result).toBe('swallowed');
            expect(owners.records.size).toBe(0);
        });

        test('an error discards changes and is rethrown', async () => {
            // ACT & ASSERT
            await expect(
                manager.run(async (tx) => {
                    await tx.create('owners', { name: 'Ann' });
                    throw new Error('business rule violated');
                })
            ).rejects.toThrow('business rule violated');
            expect(owners.records.size).toBe(0);
            expect(await fs.readdir(root)).not.toContain('journal.json');
        });

        test('a failed operation rejects the transaction if the body lets it propagate', async () => {
            // ACT & ASSERT
            await expect(
                manager.run(async (tx) => {
                    await tx.create('owners', { name: 'Ann' });
                    await tx.create('owners', {});
                })
            ).rejects.toThrow('"name" is required.');
            expect(owners.records.size).toBe(0);
        });

        test('the body may handle a failed operation and still commit', async () => {
            // ACT
            await manager.run(async (tx) => {
                await tx.create('owners', {}).catch(() => {});
                await tx.create('owners', { name: 'Ann' });
            });

            // ASSERT
            expect(owners.records.size).toBe(1);
        });

        test('requires a function', async () => {
            // ACT & ASSERT
            await expect(manager.run(null)).rejects.toThrow(TypeError);
        });
    });

    describe('transaction lifecycle', () => {
        test('a leaked transaction cannot be used after it finished', async () => {
            // ARRANGE
            let leaked;
            await manager.run(async (tx) => {
                leaked = tx;
            });

            // ACT & ASSERT
            await expect(
                leaked.create('owners', { name: 'Late' })
            ).rejects.toMatchObject({ code: 'TRANSACTION_CLOSED' });
            expect(() => leaked.rollback()).toThrow(
                expect.objectContaining({ code: 'TRANSACTION_CLOSED' })
            );
        });

        test('current is the active transaction inside the body only', async () => {
            // ARRANGE
            let inside;

            // ACT
            await manager.run(async (tx) => {
                await tick();
                inside = manager.current === tx;
            });

            // ASSERT
            expect(inside).toBe(true);
            expect(manager.current).toBeNull();
        });
    });

    describe('isolation', () => {
        test('transactions run one at a time', async () => {
            // ARRANGE
            const gate = deferred();
            const events = [];

            // ACT
            const first = manager.run(async (tx) => {
                events.push('first:start');
                await tx.create('owners', { name: 'First' });
                await gate.promise;
                events.push('first:end');
            });
            const second = manager.run(async (tx) => {
                events.push('second:start');
                const seen = await tx.list('owners');
                events.push(`second:sees:${seen.total}`);
            });
            await tick();
            gate.resolve();
            await Promise.all([first, second]);

            // ASSERT: the second transaction sees the first one's commit
            expect(events).toEqual([
                'first:start',
                'first:end',
                'second:start',
                'second:sees:1',
            ]);
        });

        test('reads are not blocked by a running transaction and see committed data', async () => {
            // ARRANGE
            const gate = deferred();
            const running = manager.run(async (tx) => {
                await tx.create('owners', { name: 'Uncommitted' });
                await gate.promise;
            });
            await tick();

            // ACT
            const count = await manager.read(async () => owners.records.size);

            // ASSERT
            expect(count).toBe(0);
            gate.resolve();
            await running;
            expect(owners.records.size).toBe(1);
        });

        test('reads wait while a commit is being applied', async () => {
            // ARRANGE
            const gate = deferred();
            const applyPut = owners.applyPut.bind(owners);
            owners.applyPut = async (record) => {
                await gate.promise;
                await applyPut(record);
            };
            const committing = manager.run((tx) =>
                tx.create('owners', { name: 'Ann' })
            );
            await tick();

            // ACT
            let readDone = false;
            const reading = manager
                .read(async () => owners.records.size)
                .then((size) => {
                    readDone = true;
                    return size;
                });
            await tick();

            // ASSERT
            expect(readDone).toBe(false);
            gate.resolve();
            await committing;
            await expect(reading).resolves.toBe(1);
        });
    });

    describe('apply failure', () => {
        test('keeps the journal, blocks the database and recovers on restart', async () => {
            // ARRANGE: the disk fails after the commit point
            const applyPut = owners.applyPut.bind(owners);
            let calls = 0;
            owners.applyPut = async (record) => {
                calls++;
                if (calls === 2) throw new Error('disk failure');
                await applyPut(record);
            };

            // ACT
            const failed = manager.run(async (tx) => {
                await tx.create('owners', { name: 'Ann' });
                await tx.create('owners', { name: 'Bob' });
            });

            // ASSERT
            await expect(failed).rejects.toMatchObject({
                code: 'DATABASE_NEEDS_RECOVERY',
                status: 503,
            });
            expect(await fileExists(journal.path)).toBe(true);
            await expect(manager.run(async () => {})).rejects.toMatchObject({
                code: 'DATABASE_NEEDS_RECOVERY',
            });
            await expect(manager.read(async () => {})).rejects.toMatchObject({
                code: 'DATABASE_NEEDS_RECOVERY',
            });

            const reopened = await new FileDatabase(root).init();
            const names = (await reopened.list('owners')).items.map(
                (o) => o.name
            );
            expect(names.sort()).toEqual(['Ann', 'Bob']);
        });
    });
});
