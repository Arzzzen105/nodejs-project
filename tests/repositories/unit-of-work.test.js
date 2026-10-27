import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import { FileDatabase } from '../../src/storage/file-database.js';
import { UnitOfWork } from '../../src/repositories/unit-of-work.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
} from '../helpers/temp-db.js';

const OWNERS = {
    table: 'owners',
    primaryKey: 'id',
    columns: { name: { type: 'string', required: true } },
    indexes: ['name'],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('UnitOfWork', () => {
    let root;
    let db;
    let uow;

    const names = async () =>
        (await db.list('owners', { sort: 'name' })).items.map((o) => o.name);
    const create = (name) => uow.executor().create('owners', { name });

    beforeEach(async () => {
        root = await createTempDir();
        await writeCollectionConfig(root, 'owners', OWNERS);
        db = await new FileDatabase(root).init();
        uow = new UnitOfWork(db);
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    describe('executor', () => {
        test('is the database outside a unit', () => {
            expect(uow.executor()).toBe(db);
            expect(uow.active).toBe(false);
        });

        test('is the transaction inside a unit', async () => {
            await uow.run(async () => {
                expect(uow.executor()).not.toBe(db);
                expect(uow.active).toBe(true);
            });
            expect(uow.executor()).toBe(db);
        });
    });

    describe('run', () => {
        test('commits the changes and resolves with the result', async () => {
            // ACT
            const result = await uow.run(async () => {
                await create('Ann');
                await create('Bob');
                return 'done';
            });

            // ASSERT
            expect(result).toBe('done');
            expect(await names()).toEqual(['Ann', 'Bob']);
        });

        test('an error rolls everything back and is rethrown as is', async () => {
            // ARRANGE
            const failure = new Error('business rule');

            // ACT & ASSERT
            await expect(
                uow.run(async () => {
                    await create('Ann');
                    throw failure;
                })
            ).rejects.toBe(failure);
            expect(await names()).toEqual([]);
        });

        test('changes are visible inside, but not outside until the commit', async () => {
            // ARRANGE: the unit pauses after its write
            let created;
            let release;
            const written = new Promise((resolve) => (created = resolve));
            const gate = new Promise((resolve) => (release = resolve));
            const running = uow.run(async () => {
                await create('Ann');
                created((await uow.executor().list('owners')).total);
                await gate;
            });

            // ACT: a read from outside the unit, e.g. another request
            const insideTotal = await written;
            const outsideTotal = (await db.list('owners')).total;
            release();
            await running;

            // ASSERT
            expect(insideTotal).toBe(1);
            expect(outsideTotal).toBe(0);
            expect(await names()).toEqual(['Ann']);
        });

        test('passes options to a new transaction', async () => {
            await expect(
                uow.run(() => sleep(200), { timeout: 20 })
            ).rejects.toMatchObject({ code: 'TRANSACTION_TIMEOUT' });
        });

        test('requires a function', async () => {
            await expect(uow.run()).rejects.toThrow(TypeError);
        });
    });

    describe('nested units join the running transaction', () => {
        test('inner and outer share one transaction and commit together', async () => {
            // ARRANGE
            const executors = [];

            // ACT
            await uow.run(async () => {
                executors.push(uow.executor());
                await create('Ann');
                await uow.run(async () => {
                    executors.push(uow.executor());
                    await create('Bob');
                });
            });

            // ASSERT
            expect(executors[1]).toBe(executors[0]);
            expect(await names()).toEqual(['Ann', 'Bob']);
        });

        test('a failure after the inner unit rolls back its changes too', async () => {
            // ACT
            await expect(
                uow.run(async () => {
                    await uow.run(() => create('Ann'));
                    throw new Error('later');
                })
            ).rejects.toThrow('later');

            // ASSERT
            expect(await names()).toEqual([]);
        });

        test('an error the inner unit handles itself does not doom the transaction', async () => {
            // ACT
            await uow.run(async () => {
                await uow.run(async () => {
                    try {
                        await uow.executor().create('owners', {});
                    } catch {
                        await create('Fallback');
                    }
                });
            });

            // ASSERT
            expect(await names()).toEqual(['Fallback']);
        });

        test('a failed single operation is not a unit and can be handled', async () => {
            // ACT
            await uow.run(async () => {
                await expect(
                    uow.executor().create('owners', {})
                ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
                await create('Ann');
            });

            // ASSERT
            expect(await names()).toEqual(['Ann']);
        });

        test('options of a joined unit are ignored', async () => {
            // ACT: the inner timeout would fire, but the outer one has none
            await uow.run(async () => {
                await uow.run(
                    async () => {
                        await sleep(60);
                        await create('Ann');
                    },
                    { timeout: 10 }
                );
            });

            // ASSERT
            expect(await names()).toEqual(['Ann']);
        });

        test('parallel inner units in one transaction join it as well', async () => {
            // ACT
            await uow.run(() =>
                Promise.all([
                    uow.run(() => create('Ann')),
                    uow.run(() => create('Bob')),
                ])
            );

            // ASSERT
            expect(await names()).toEqual(['Ann', 'Bob']);
        });
    });

    describe('the first error wins', () => {
        test('a nested error caught by the outer body still rolls back, with that error', async () => {
            // ARRANGE
            const inner = new Error('group is full');

            // ACT
            const outcome = uow.run(async () => {
                await create('Ann');
                try {
                    await uow.run(async () => {
                        await create('Bob');
                        throw inner;
                    });
                } catch {
                    // swallowed: the outer body tries to carry on
                }
                return 'looks fine';
            });

            // ASSERT
            await expect(outcome).rejects.toBe(inner);
            expect(await names()).toEqual([]);
        });

        test('after a nested failure the database is unreachable at once', async () => {
            // ARRANGE
            const inner = new Error('group is full');
            let continued;

            // ACT
            const outcome = uow.run(async () => {
                await uow
                    .run(async () => {
                        throw inner;
                    })
                    .catch(() => {});
                try {
                    uow.executor();
                    continued = 'executor';
                } catch (error) {
                    continued = error;
                }
                await uow.run(async () => {
                    continued = 'nested body ran';
                });
            });

            // ASSERT
            await expect(outcome).rejects.toBe(inner);
            expect(continued).toBe(inner);
        });

        test('a later error does not replace the first one', async () => {
            // ARRANGE
            const first = new Error('first');

            // ACT
            const outcome = uow.run(async () => {
                await uow
                    .run(async () => {
                        throw first;
                    })
                    .catch(() => {});
                throw new Error('second');
            });

            // ASSERT
            await expect(outcome).rejects.toBe(first);
        });

        test('of parallel nested failures the one that happened first wins', async () => {
            // ARRANGE
            const early = new Error('early');
            const late = new Error('late');
            const fail = (error, ms) =>
                uow.run(async () => {
                    await sleep(ms);
                    throw error;
                });

            // ACT
            const outcome = uow.run(() =>
                Promise.allSettled([fail(late, 40), fail(early, 5)])
            );

            // ASSERT
            await expect(outcome).rejects.toBe(early);
        });

        test('errors keep their status and code for the HTTP response', async () => {
            // ARRANGE
            const conflict = Object.assign(new Error('Group is full.'), {
                status: 409,
                code: 'GROUP_IS_FULL',
            });

            // ACT & ASSERT
            await expect(
                uow.run(() =>
                    uow.run(async () => {
                        throw conflict;
                    })
                )
            ).rejects.toMatchObject({ status: 409, code: 'GROUP_IS_FULL' });
        });

        test('a failed transaction does not affect the next one', async () => {
            // ARRANGE
            await uow
                .run(() =>
                    uow.run(async () => {
                        throw new Error('no');
                    })
                )
                .catch(() => {});

            // ACT
            await uow.run(() => create('Ann'));

            // ASSERT
            expect(uow.executor()).toBe(db);
            expect(await names()).toEqual(['Ann']);
        });
    });

    describe('independent units', () => {
        test('concurrent units get their own transactions', async () => {
            // ARRANGE
            const executors = [];
            const unit = (name) =>
                uow.run(async () => {
                    executors.push(uow.executor());
                    await sleep(10);
                    await create(name);
                    // still its own transaction after awaiting
                    executors.push(uow.executor());
                });

            // ACT
            await Promise.all([unit('Ann'), unit('Bob')]);

            // ASSERT
            const [annStart, annEnd, bobStart, bobEnd] = executors;
            expect(annEnd).toBe(annStart);
            expect(bobEnd).toBe(bobStart);
            expect(bobStart).not.toBe(annStart);
            expect(await names()).toEqual(['Ann', 'Bob']);
        });

        test('a failing unit does not affect a concurrent one', async () => {
            // ACT
            const results = await Promise.allSettled([
                uow.run(async () => {
                    await create('Ann');
                    throw new Error('no');
                }),
                uow.run(() => create('Bob')),
            ]);

            // ASSERT
            expect(results.map((r) => r.status)).toEqual([
                'rejected',
                'fulfilled',
            ]);
            expect(await names()).toEqual(['Bob']);
        });

        test('a unit inside a transaction opened on the database directly is rejected', async () => {
            // the database refuses db.* calls inside a transaction; going around
            // the unit of work is caught instead of silently opening a second one
            await expect(
                db.transaction(() => uow.run(() => create('Ann')))
            ).rejects.toMatchObject({ code: 'INVALID_TRANSACTION_USE' });
        });
    });
});
