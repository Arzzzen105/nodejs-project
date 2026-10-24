import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { threadId } from 'node:worker_threads';
import { ProcessLock } from '../../src/storage/process-lock.js';
import { createTempDir, removeDir, fileExists } from '../helpers/temp-db.js';

/** PID of a process that has already exited. */
async function deadPid() {
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => child.on('exit', resolve));
    return child.pid;
}

describe('ProcessLock', () => {
    let root;
    let lock;

    async function writeOwner(owner) {
        await fs.writeFile(lock.path, JSON.stringify(owner));
    }

    async function readOwner() {
        return JSON.parse(await fs.readFile(lock.path, 'utf8'));
    }

    beforeEach(async () => {
        root = await createTempDir();
        lock = new ProcessLock(root);
    });

    afterEach(async () => {
        await lock.release();
        await removeDir(root);
    });

    test('acquire writes the owner and release removes the file', async () => {
        // ACT
        await lock.acquire();

        // ASSERT
        expect(await readOwner()).toEqual({
            pid: process.pid,
            threadId,
            hostname: os.hostname(),
            startedAt: expect.any(String),
            token: expect.any(String),
        });
        await lock.release();
        expect(await fileExists(lock.path)).toBe(false);
    });

    test('leaves no temporary files', async () => {
        // ACT
        await lock.acquire();

        // ASSERT
        expect(await fs.readdir(root)).toEqual(['.lock']);
    });

    test('acquire and release are idempotent', async () => {
        // ACT & ASSERT
        await lock.acquire();
        await lock.acquire();
        await lock.release();
        expect(await fileExists(lock.path)).toBe(false);
        await expect(lock.release()).resolves.toBeUndefined();
    });

    test('a second lock in the same process is rejected', async () => {
        // ARRANGE: two open databases in one process would diverge just like
        // two processes, because each keeps its own in-memory indexes
        const second = new ProcessLock(root);
        await lock.acquire();

        // ACT & ASSERT
        await expect(second.acquire()).rejects.toMatchObject({
            code: 'DATABASE_LOCKED',
            message: expect.stringContaining('this process'),
        });
        await lock.release();
        await expect(second.acquire()).resolves.toBeUndefined();
        await second.release();
    });

    test('regression: of two locks acquired at the same time only one wins', async () => {
        // ARRANGE: the second lock used to find the first one's file with this
        // PID and thread before it was in `held`, and took it over as stale
        for (let run = 0; run < 20; run++) {
            const first = new ProcessLock(root);
            const second = new ProcessLock(root);

            // ACT
            const results = await Promise.allSettled([
                first.acquire(),
                second.acquire(),
            ]);

            // ASSERT
            expect(results.map((result) => result.status)).toEqual([
                'fulfilled',
                'rejected',
            ]);
            expect(results[1].reason).toMatchObject({
                code: 'DATABASE_LOCKED',
            });
            await first.release();
            expect(await fileExists(first.path)).toBe(false);
        }
    });

    test('a failed acquire does not keep the directory claimed', async () => {
        // ARRANGE
        await writeOwner({
            pid: await deadPid(),
            hostname: `${os.hostname()}-other`,
            startedAt: 'earlier',
        });
        await expect(lock.acquire()).rejects.toMatchObject({
            code: 'DATABASE_LOCKED',
        });

        // ACT
        await fs.rm(lock.path);

        // ASSERT
        await expect(lock.acquire()).resolves.toBeUndefined();
        expect((await readOwner()).pid).toBe(process.pid);
    });

    test('regression: a lock of an earlier run with the same PID is taken over', async () => {
        // ARRANGE: a container restarted after a crash gets the same PID (often 1)
        // and hostname, so the stale lock looks like it belongs to this process
        await writeOwner({
            pid: process.pid,
            threadId,
            hostname: os.hostname(),
            startedAt: 'before the crash',
            token: 'previous-run',
        });

        // ACT
        await lock.acquire();

        // ASSERT
        expect(await readOwner()).toMatchObject({
            pid: process.pid,
            token: expect.not.stringMatching('previous-run'),
        });
    });

    test('a lock of another worker thread of this process is kept', async () => {
        // ARRANGE: each thread has its own module state, so the lock cannot be
        // checked from here; the other thread is assumed to be using it
        await writeOwner({
            pid: process.pid,
            threadId: threadId + 1,
            hostname: os.hostname(),
            startedAt: 'earlier',
            token: 'other-thread',
        });

        // ACT & ASSERT
        await expect(lock.acquire()).rejects.toMatchObject({
            code: 'DATABASE_LOCKED',
        });
    });

    test('the error explains how to recover from a stale lock', async () => {
        // ARRANGE
        await writeOwner({
            pid: process.ppid,
            hostname: `${os.hostname()}-container`,
            startedAt: 'earlier',
        });

        // ACT & ASSERT
        await expect(lock.acquire()).rejects.toMatchObject({
            message: expect.stringContaining(`delete ${lock.path}`),
        });
    });

    test('a live process on this host keeps the lock', async () => {
        // ARRANGE: the parent of the test runner is alive and is not us
        await writeOwner({
            pid: process.ppid,
            hostname: os.hostname(),
            startedAt: 'earlier',
        });

        // ACT & ASSERT
        await expect(lock.acquire()).rejects.toMatchObject({
            code: 'DATABASE_LOCKED',
            status: 503,
            message: expect.stringContaining(`process ${process.ppid}`),
        });
        expect((await readOwner()).pid).toBe(process.ppid);
    });

    test('a lock of a crashed process is taken over', async () => {
        // ARRANGE
        await writeOwner({
            pid: await deadPid(),
            hostname: os.hostname(),
            startedAt: 'earlier',
        });

        // ACT
        await lock.acquire();

        // ASSERT
        expect((await readOwner()).pid).toBe(process.pid);
    });

    test('a lock of another host is never taken over', async () => {
        // ARRANGE
        await writeOwner({
            pid: await deadPid(),
            hostname: `${os.hostname()}-other`,
            startedAt: 'earlier',
        });

        // ACT & ASSERT
        await expect(lock.acquire()).rejects.toMatchObject({
            code: 'DATABASE_LOCKED',
        });
    });

    test('an unreadable lock file is taken over', async () => {
        // ARRANGE
        await fs.writeFile(lock.path, 'garbage');

        // ACT
        await lock.acquire();

        // ASSERT
        expect((await readOwner()).pid).toBe(process.pid);
    });

    test('release keeps a lock file that belongs to someone else', async () => {
        // ARRANGE
        await lock.acquire();
        await writeOwner({
            pid: process.ppid,
            hostname: os.hostname(),
            startedAt: 'later',
        });

        // ACT
        await lock.release();

        // ASSERT
        expect((await readOwner()).pid).toBe(process.ppid);
    });
});
