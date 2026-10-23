import { describe, test, expect } from 'vitest';
import { ReadWriteLock } from '../../src/storage/lock-manager.js';

function deferred() {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

describe('ReadWriteLock', () => {
    const tick = () => new Promise((r) => setTimeout(r, 5));

    test('returns operation results', async () => {
        const lock = new ReadWriteLock();
        await expect(lock.withRead(async () => 'r')).resolves.toBe('r');
        await expect(lock.withWrite(async () => 'w')).resolves.toBe('w');
    });

    test('readers run concurrently', async () => {
        const lock = new ReadWriteLock();
        const gate = deferred();
        let active = 0;
        let maxActive = 0;
        const reader = () =>
            lock.withRead(async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                await gate.promise;
                active--;
            });

        const readers = [reader(), reader(), reader()];
        await tick();
        gate.resolve();
        await Promise.all(readers);

        expect(maxActive).toBe(3);
    });

    test('a writer waits for active readers and blocks new ones', async () => {
        const lock = new ReadWriteLock();
        const gate = deferred();
        const events = [];

        const reader = lock.withRead(async () => {
            events.push('read:start');
            await gate.promise;
            events.push('read:end');
        });
        await tick();
        const writer = lock.withWrite(async () => {
            events.push('write');
        });
        const lateReader = lock.withRead(async () => {
            events.push('late-read');
        });

        await tick();
        expect(events).toEqual(['read:start']);
        gate.resolve();
        await Promise.all([reader, writer, lateReader]);
        expect(events).toEqual([
            'read:start',
            'read:end',
            'write',
            'late-read',
        ]);
    });

    test('writers are exclusive', async () => {
        const lock = new ReadWriteLock();
        let active = 0;
        let maxActive = 0;
        await Promise.all(
            [1, 2, 3].map(() =>
                lock.withWrite(async () => {
                    active++;
                    maxActive = Math.max(maxActive, active);
                    await tick();
                    active--;
                })
            )
        );
        expect(maxActive).toBe(1);
    });

    test('releases the lock when the operation throws', async () => {
        const lock = new ReadWriteLock();
        await expect(
            lock.withWrite(async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');
        await expect(
            lock.withRead(async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');
        await expect(lock.withWrite(async () => 'free')).resolves.toBe('free');
    });
});
