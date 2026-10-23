import { describe, test, expect } from 'vitest';
import { LockManager, lockKey } from '../../src/storage/lock-manager.js';

function deferred() {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

describe('LockManager', () => {
    test('returns the operation result', async () => {
        const locks = new LockManager();
        await expect(locks.withLock('k', async () => 42)).resolves.toBe(42);
    });

    test('serializes operations on the same key', async () => {
        const locks = new LockManager();
        const events = [];
        const gate = deferred();

        const first = locks.withLock('k', async () => {
            events.push('first:start');
            await gate.promise;
            events.push('first:end');
        });
        const second = locks.withLock('k', async () => {
            events.push('second:start');
        });

        await new Promise((r) => setTimeout(r, 10));
        expect(events).toEqual(['first:start']);

        gate.resolve();
        await Promise.all([first, second]);
        expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    });

    test('runs operations in request order', async () => {
        const locks = new LockManager();
        const order = [];
        await Promise.all(
            [1, 2, 3, 4, 5].map((n) =>
                locks.withLock('k', async () => {
                    await new Promise((r) => setTimeout(r, 5 - n));
                    order.push(n);
                })
            )
        );
        expect(order).toEqual([1, 2, 3, 4, 5]);
    });

    test('does not block operations on different keys', async () => {
        const locks = new LockManager();
        const gate = deferred();
        const events = [];

        const blocked = locks.withLock('a', async () => {
            await gate.promise;
            events.push('a');
        });
        await locks.withLock('b', async () => {
            events.push('b');
        });

        expect(events).toEqual(['b']);
        gate.resolve();
        await blocked;
        expect(events).toEqual(['b', 'a']);
    });

    test('releases the lock when the operation throws', async () => {
        const locks = new LockManager();

        await expect(
            locks.withLock('k', async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');

        await expect(locks.withLock('k', async () => 'next')).resolves.toBe(
            'next'
        );
    });

    test('a failed operation does not fail queued ones', async () => {
        const locks = new LockManager();
        const results = await Promise.allSettled([
            locks.withLock('k', async () => {
                throw new Error('boom');
            }),
            locks.withLock('k', async () => 'ok'),
        ]);
        expect(results[0].status).toBe('rejected');
        expect(results[1]).toEqual({ status: 'fulfilled', value: 'ok' });
    });
});

describe('LockManager reentrancy', () => {
    test('the same key can be locked again inside the operation', async () => {
        const locks = new LockManager();
        const result = await locks.withLock('k', () =>
            locks.withLock('k', async () => 'nested')
        );
        expect(result).toBe('nested');
    });

    test('reentrancy survives awaits inside the operation', async () => {
        const locks = new LockManager();
        const result = await locks.withLock('k', async () => {
            await new Promise((r) => setTimeout(r, 1));
            return locks.withLock('k', async () => 'after-await');
        });
        expect(result).toBe('after-await');
    });

    test('held keys do not leak to unrelated callers', async () => {
        const locks = new LockManager();
        const gate = deferred();
        const events = [];

        const holder = locks.withLock('k', async () => {
            await gate.promise;
            events.push('holder');
        });
        const outsider = locks.withLock('k', async () => {
            events.push('outsider');
        });

        await new Promise((r) => setTimeout(r, 10));
        expect(events).toEqual([]);
        gate.resolve();
        await Promise.all([holder, outsider]);
        expect(events).toEqual(['holder', 'outsider']);
    });
});

describe('LockManager.withLocks', () => {
    test('holds all keys during the operation', async () => {
        const locks = new LockManager();
        const gate = deferred();
        const events = [];

        const multi = locks.withLocks(['a', 'b'], async () => {
            events.push('multi:start');
            await gate.promise;
            events.push('multi');
        });
        // let withLocks acquire both keys before a competitor arrives
        await new Promise((r) => setTimeout(r, 5));
        expect(events).toEqual(['multi:start']);

        const onB = locks.withLock('b', async () => {
            events.push('b');
        });

        await new Promise((r) => setTimeout(r, 10));
        expect(events).toEqual(['multi:start']);
        gate.resolve();
        await Promise.all([multi, onB]);
        expect(events).toEqual(['multi:start', 'multi', 'b']);
    });

    test('overlapping key sets in opposite order do not deadlock', async () => {
        const locks = new LockManager();
        const order = [];
        const run = (keys, label) =>
            locks.withLocks(keys, async () => {
                await new Promise((r) => setTimeout(r, 5));
                order.push(label);
            });

        await Promise.all([
            run(['a', 'b', 'c'], 'first'),
            run(['c', 'b', 'a'], 'second'),
            run(['b', 'a'], 'third'),
        ]);
        expect(order.sort()).toEqual(['first', 'second', 'third']);
    });

    test('duplicate keys are acquired once', async () => {
        const locks = new LockManager();
        await expect(
            locks.withLocks(['a', 'a', 'a'], async () => 'ok')
        ).resolves.toBe('ok');
    });

    test('empty key list runs the operation immediately', async () => {
        const locks = new LockManager();
        await expect(locks.withLocks([], async () => 'ok')).resolves.toBe('ok');
    });

    test('nested single-key lock of an already held key is reentrant', async () => {
        const locks = new LockManager();
        const result = await locks.withLocks(['a', 'b'], () =>
            locks.withLock('b', async () => 'inner')
        );
        expect(result).toBe('inner');
    });

    test('releases all keys when the operation throws', async () => {
        const locks = new LockManager();
        await expect(
            locks.withLocks(['a', 'b'], async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');
        await expect(
            locks.withLocks(['b', 'a'], async () => 'free')
        ).resolves.toBe('free');
    });
});

describe('lockKey', () => {
    test('builds "<collection>:<id>" keys', () => {
        expect(lockKey('items', 'abc')).toBe('items:abc');
    });

    test('different records get different keys', () => {
        expect(lockKey('items', 'a')).not.toBe(lockKey('notes', 'a'));
        expect(lockKey('items', 'a')).not.toBe(lockKey('items', 'b'));
    });
});
