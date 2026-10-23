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
    insert,
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

        test('single-change commits are journaled too', async () => {
            // ARRANGE
            const write = journal.write.bind(journal);
            const written = [];
            journal.write = async (changes) => {
                written.push(changes.length);
                await write(changes);
            };

            // ACT
            const owner = await manager.run((tx) =>
                tx.create('owners', { name: 'Ann' })
            );

            // ASSERT
            expect(written).toEqual([1]);
            await expect(owners.get(owner.id)).resolves.toEqual(owner);
            expect(await fileExists(journal.path)).toBe(false);
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
            const owner = await insert(owners, { name: 'Ann' });

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
            expect(owners.ids().size).toBe(0);
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
            expect(owners.ids().size).toBe(0);
        });

        test('an error discards changes and is rethrown', async () => {
            // ACT & ASSERT
            await expect(
                manager.run(async (tx) => {
                    await tx.create('owners', { name: 'Ann' });
                    throw new Error('business rule violated');
                })
            ).rejects.toThrow('business rule violated');
            expect(owners.ids().size).toBe(0);
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
            expect(owners.ids().size).toBe(0);
        });

        test('the body may handle a failed operation and still commit', async () => {
            // ACT
            await manager.run(async (tx) => {
                await tx.create('owners', {}).catch(() => {});
                await tx.create('owners', { name: 'Ann' });
            });

            // ASSERT
            expect(owners.ids().size).toBe(1);
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

        test('an operation arriving during the commit is rejected, not lost', async () => {
            // ARRANGE: hold the commit while a timer started by the body fires
            const gate = deferred();
            const applyPut = owners.applyPut.bind(owners);
            owners.applyPut = async (record) => {
                await gate.promise;
                await applyPut(record);
            };
            let late;

            // ACT
            const committing = manager.run(async (tx) => {
                await tx.create('owners', { name: 'Ann' });
                setTimeout(() => {
                    late = tx.create('owners', { name: 'Late' });
                    late.catch(() => {});
                }, 0);
            });
            await tick();
            gate.resolve();
            await committing;

            // ASSERT
            await expect(late).rejects.toMatchObject({
                code: 'TRANSACTION_CLOSED',
            });
            expect((await owners.list()).items.map((o) => o.name)).toEqual([
                'Ann',
            ]);
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
            const count = await manager.read(async () => owners.ids().size);

            // ASSERT
            expect(count).toBe(0);
            gate.resolve();
            await running;
            expect(owners.ids().size).toBe(1);
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
                .read(async () => owners.ids().size)
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

    describe('journal failures', () => {
        test('regression: a failed clear never lets an old journal overwrite newer data', async () => {
            // ARRANGE: the first commit is applied, but its journal cannot be removed
            const clear = journal.clear.bind(journal);
            journal.clear = async () => {
                throw new Error('EIO');
            };

            // ACT
            const [a, b] = await manager.run(async (tx) => [
                await tx.create('owners', { name: 'v1' }),
                await tx.create('owners', { name: 'b' }),
            ]);
            journal.clear = clear;

            // ASSERT: the applied commit is reported as successful...
            expect(a.name).toBe('v1');
            await expect(owners.get(b.id)).resolves.toEqual(b);
            // ...but no newer commit may run while that journal is on disk
            await expect(
                manager.run((tx) => tx.update('owners', a.id, { name: 'v2' }))
            ).rejects.toMatchObject({ code: 'DATABASE_NEEDS_RECOVERY' });
            await expect(
                manager.run((tx) => tx.delete('owners', b.id))
            ).rejects.toMatchObject({ code: 'DATABASE_NEEDS_RECOVERY' });

            // restart replays the journal, which is still the latest commit
            const reopened = await new FileDatabase(root).init();
            await expect(reopened.get('owners', a.id)).resolves.toEqual(a);
            await expect(reopened.get('owners', b.id)).resolves.toEqual(b);
            expect(await fileExists(journal.path)).toBe(false);
        });

        test('a journal left by a failed clear is replaced by the next commit after restart', async () => {
            // ARRANGE
            journal.clear = async () => {
                throw new Error('EIO');
            };
            const owner = await manager.run((tx) =>
                tx.create('owners', { name: 'v1' })
            );

            // ACT: restart, then a newer single-change commit
            const reopened = await new FileDatabase(root).init();
            await reopened.update('owners', owner.id, { name: 'v2' });
            const again = await new FileDatabase(root).init();

            // ASSERT
            expect((await again.get('owners', owner.id)).name).toBe('v2');
        });

        test('a failed journal write is discarded and the database stays usable', async () => {
            // ARRANGE: the journal reaches the disk, then the write reports an error
            const write = journal.write.bind(journal);
            journal.write = async (changes) => {
                await write(changes);
                throw new Error('fsync failed');
            };

            // ACT & ASSERT
            await expect(
                manager.run((tx) => tx.create('owners', { name: 'Ann' }))
            ).rejects.toThrow('fsync failed');
            expect(owners.ids().size).toBe(0);
            expect(await fileExists(journal.path)).toBe(false);

            journal.write = write;
            await expect(
                manager.run((tx) => tx.create('owners', { name: 'Bob' }))
            ).resolves.toMatchObject({ name: 'Bob' });
        });

        test('if a failed journal cannot be removed, the database needs recovery', async () => {
            // ARRANGE
            const write = journal.write.bind(journal);
            journal.write = async (changes) => {
                await write(changes);
                throw new Error('fsync failed');
            };
            journal.clear = async () => {
                throw new Error('EIO');
            };

            // ACT & ASSERT
            await expect(
                manager.run((tx) => tx.create('owners', { name: 'Ann' }))
            ).rejects.toMatchObject({ code: 'DATABASE_NEEDS_RECOVERY' });
            await expect(manager.read(async () => {})).rejects.toMatchObject({
                code: 'DATABASE_NEEDS_RECOVERY',
            });
        });
    });

    describe('timeout', () => {
        function managerWithTimeout(timeout) {
            return new TransactionManager({
                journal,
                collection: () => owners,
                relations: new RelationManager(new Map([['owners', OWNERS]])),
                timeout,
            });
        }

        test('a slow body is rolled back and frees the writer slot', async () => {
            // ARRANGE
            const limited = managerWithTimeout(20);
            const never = new Promise(() => {});
            let late;

            // ACT
            const stuck = limited.run(async (tx) => {
                await tx.create('owners', { name: 'Stuck' });
                await never;
            });
            const slow = limited.run(async (tx) => {
                await tx.create('owners', { name: 'Slow' });
                await new Promise((r) => setTimeout(r, 60));
                late = tx.create('owners', { name: 'Late' });
                late.catch(() => {});
            });
            const next = limited.run((tx) =>
                tx.create('owners', { name: 'Next' })
            );

            // ASSERT
            await expect(stuck).rejects.toMatchObject({
                code: 'TRANSACTION_TIMEOUT',
                status: 503,
            });
            await expect(slow).rejects.toMatchObject({
                code: 'TRANSACTION_TIMEOUT',
            });
            await expect(next).resolves.toMatchObject({ name: 'Next' });
            await new Promise((r) => setTimeout(r, 60));
            await expect(late).rejects.toMatchObject({
                code: 'TRANSACTION_CLOSED',
            });
            expect((await owners.list()).items.map((o) => o.name)).toEqual([
                'Next',
            ]);
        });

        test('the commit itself is not limited by the timeout', async () => {
            // ARRANGE: applying takes longer than the timeout
            const limited = managerWithTimeout(20);
            const applyPut = owners.applyPut.bind(owners);
            owners.applyPut = async (record) => {
                await new Promise((r) => setTimeout(r, 50));
                await applyPut(record);
            };

            // ACT & ASSERT
            await expect(
                limited.run((tx) => tx.create('owners', { name: 'Ann' }))
            ).resolves.toMatchObject({ name: 'Ann' });
            expect(owners.ids().size).toBe(1);
        });

        test('0 disables the timeout', async () => {
            // ARRANGE
            const unlimited = managerWithTimeout(0);

            // ACT & ASSERT
            await expect(
                unlimited.run(async (tx) => {
                    await new Promise((r) => setTimeout(r, 30));
                    return tx.create('owners', { name: 'Patient' });
                })
            ).resolves.toMatchObject({ name: 'Patient' });
        });

        test('rejects invalid timeouts', () => {
            expect(() => managerWithTimeout(-1)).toThrow(TypeError);
            expect(() => managerWithTimeout(NaN)).toThrow(TypeError);
        });
    });

    describe('close', () => {
        test('waits for the running transaction and rejects new work', async () => {
            // ARRANGE
            const gate = deferred();
            const running = manager.run(async (tx) => {
                await tx.create('owners', { name: 'Ann' });
                await gate.promise;
            });
            await tick();

            // ACT
            const closing = manager.close();

            // ASSERT
            await expect(manager.run(async () => {})).rejects.toMatchObject({
                code: 'DATABASE_CLOSED',
            });
            await expect(manager.read(async () => {})).rejects.toMatchObject({
                code: 'DATABASE_CLOSED',
            });
            gate.resolve();
            await Promise.all([running, closing]);
            expect(owners.ids().size).toBe(1);
        });

        test('waits for active reads', async () => {
            // ARRANGE
            const gate = deferred();
            let readDone = false;
            const reading = manager.read(async () => {
                await gate.promise;
                readDone = true;
            });

            // ACT
            let closed = false;
            const closing = manager.close().then(() => {
                closed = true;
            });
            await tick();

            // ASSERT
            expect(closed).toBe(false);
            gate.resolve();
            await Promise.all([reading, closing]);
            expect(readDone).toBe(true);
        });
    });

    describe('apply failure', () => {
        test('a failed single change also needs recovery and is replayed on restart', async () => {
            // ARRANGE
            owners.applyPut = async () => {
                throw new Error('disk full');
            };

            // ACT & ASSERT
            await expect(
                manager.run((tx) => tx.create('owners', { name: 'Ann' }))
            ).rejects.toMatchObject({ code: 'DATABASE_NEEDS_RECOVERY' });
            await expect(manager.run(async () => {})).rejects.toMatchObject({
                code: 'DATABASE_NEEDS_RECOVERY',
            });

            const reopened = await new FileDatabase(root).init();
            const names = (await reopened.list('owners')).items.map(
                (o) => o.name
            );
            expect(names).toEqual(['Ann']);
        });

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
