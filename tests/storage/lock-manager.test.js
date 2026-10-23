import { describe, test, expect } from 'vitest';
import { LockManager } from '../../src/storage/lock-manager.js';

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
