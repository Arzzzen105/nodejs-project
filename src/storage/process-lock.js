import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { DatabaseError, DatabaseErrors } from './errors.js';
import { defaultLogger } from './logger-contract.js';

const LOCK_FILE = '.lock';

// Lock files held by open FileDatabase instances of this process. A directory may
// be used by one open instance only: two instances, even in one process, keep
// separate in-memory indexes that silently diverge from the files.
const held = new Set();

/**
 * @typedef {object} LockOwner
 * @property {number} pid
 * @property {number} [threadId] Worker thread that holds the lock; 0 is the main thread
 * @property {string} hostname
 * @property {string} startedAt
 * @property {string} token Unique per acquisition
 */

/**
 * Lock file in the database root that keeps a database directory in use by a
 * single open FileDatabase. A lock left by a crashed process on this host is
 * detected by its PID and taken over. That includes a lock with this very PID
 * and thread: a container restarted after a crash often gets the same PID
 * (e.g. 1), and an open lock of this thread would already be in `held`.
 *
 * Limitations: two processes taking over the same stale lock at the same moment
 * can, in a very narrow window, both succeed (only OS-level locks such as flock
 * close it completely), and a reused PID makes a stale lock look alive. The error
 * message tells how to remove the lock by hand in such cases.
 */
export class ProcessLock {
    #path;
    #logger;
    #token = null;

    /**
     * @param {string} root Database root directory
     * @param {import('./logger-contract.js').Logger} [logger]
     */
    constructor(root, logger = defaultLogger) {
        this.#path = path.join(root, LOCK_FILE);
        this.#logger = logger;
    }

    /** @returns {string} */
    get path() {
        return this.#path;
    }

    /**
     * @returns {Promise<void>}
     * @throws {DatabaseError} DATABASE_LOCKED if the directory is already in use
     */
    async acquire() {
        if (this.#token) return;
        if (held.has(this.#path)) {
            throw this.#locked('another open FileDatabase of this process');
        }
        const owner = {
            pid: process.pid,
            threadId,
            hostname: os.hostname(),
            startedAt: new Date().toISOString(),
            token: randomUUID(),
        };
        await this.#create(owner);
        held.add(this.#path);
        this.#token = owner.token;
    }

    /**
     * Removes the lock file if it still belongs to this lock.
     * @returns {Promise<void>}
     */
    async release() {
        if (!this.#token) return;
        const token = this.#token;
        this.#token = null;
        held.delete(this.#path);
        if ((await this.#readOwner())?.token === token) {
            await fs.rm(this.#path, { force: true });
        }
    }

    /**
     * @param {LockOwner} owner
     */
    async #create(owner) {
        // Write the content first and link it into place, so other processes
        // never observe an empty lock file.
        const temporary = `${this.#path}.${owner.token}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(owner)}\n`);
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    await fs.link(temporary, this.#path);
                } catch (error) {
                    if (error.code !== 'EEXIST') throw error;
                    const existing = await this.#readOwner();
                    if (existing && isAlive(existing)) {
                        throw this.#locked(describe(existing));
                    }
                    // left by a crashed process (or unreadable): take it over
                    this.#logger.warn(
                        {
                            path: this.#path,
                            previousOwner: existing
                                ? {
                                      pid: existing.pid,
                                      hostname: existing.hostname,
                                  }
                                : null,
                        },
                        'Taking over a lock left by a process that is no longer running'
                    );
                    await fs.rm(this.#path, { force: true });
                    continue;
                }
                // Another process taking over the same stale lock may have
                // replaced ours in between; only the owner of the file wins.
                const current = await this.#readOwner();
                if (current?.token === owner.token) return;
                throw this.#locked(current ? describe(current) : null);
            }
            throw this.#locked(null);
        } finally {
            await fs.rm(temporary, { force: true });
        }
    }

    /** @returns {Promise<LockOwner|null>} */
    async #readOwner() {
        try {
            const owner = JSON.parse(await fs.readFile(this.#path, 'utf8'));
            return Number.isInteger(owner?.pid) ? owner : null;
        } catch {
            return null;
        }
    }

    /**
     * @param {string|null} by Who holds the directory, if known
     * @returns {DatabaseError} DATABASE_LOCKED with a hint how to recover
     */
    #locked(by) {
        return new DatabaseError(
            DatabaseErrors.DATABASE_LOCKED,
            `The database directory is already in use by ${by ?? 'another process'}. ` +
                `If that process is no longer running, delete ${this.#path} and start again.`
        );
    }
}

/**
 * @param {LockOwner} owner
 * @returns {string} e.g. "process 4242 on my-laptop (since 2026-10-23T12:00:00Z)"
 */
function describe(owner) {
    return `process ${owner.pid} on ${owner.hostname} (since ${owner.startedAt})`;
}

/**
 * @param {LockOwner} owner
 * @returns {boolean} False only if the owner is known to be dead
 */
function isAlive(owner) {
    // a process on another host cannot be checked, so it is assumed to be alive
    if (owner.hostname !== os.hostname()) return true;
    if (owner.pid === process.pid) {
        // This process: another worker thread may hold the lock (its `held` set is
        // separate), but this thread's open lock would have been found in `held`,
        // so a lock of this thread is left from an earlier run with the same PID.
        return (owner.threadId ?? 0) !== threadId;
    }
    try {
        process.kill(owner.pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}
