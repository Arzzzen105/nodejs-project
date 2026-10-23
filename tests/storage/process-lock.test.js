import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
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

    test('a lock file of this process without an open lock is not taken over', async () => {
        // ARRANGE: e.g. held by another worker thread of the same process
        await writeOwner({
            pid: process.pid,
            hostname: os.hostname(),
            startedAt: 'earlier',
            token: 'someone-else',
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
