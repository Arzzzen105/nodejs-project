import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseError } from './errors.js';

const LOCK_FILE = '.lock';

// How many FileDatabase instances of this process hold each lock file. Several
// instances in one process are allowed (e.g. reopening the database in tests);
// the lock protects against other processes, whose in-memory indexes would
// silently diverge from the files.
const holders = new Map();

/**
 * @typedef {object} LockOwner
 * @property {number} pid
 * @property {string} hostname
 * @property {string} startedAt
 */

/**
 * Lock file in the database root that keeps two processes from using the same
 * database directory at once. A lock left by a crashed process on this host is
 * detected by its PID and taken over.
 */
export class ProcessLock {
    #path;
    #held = false;

    /**
     * @param {string} root Database root directory
     */
    constructor(root) {
        this.#path = path.join(root, LOCK_FILE);
    }

    /** @returns {string} */
    get path() {
        return this.#path;
    }

    /**
     * @returns {Promise<void>}
     * @throws {DatabaseError} DATABASE_LOCKED if another live process holds the lock
     */
    async acquire() {
        if (this.#held) return;
        const count = holders.get(this.#path) ?? 0;
        if (count === 0) await this.#create();
        holders.set(this.#path, (holders.get(this.#path) ?? 0) + 1);
        this.#held = true;
    }

    /**
     * Releases the lock; the file is removed when the last holder in this process
     * releases it, and only if it still belongs to this process.
     * @returns {Promise<void>}
     */
    async release() {
        if (!this.#held) return;
        this.#held = false;
        const count = (holders.get(this.#path) ?? 1) - 1;
        if (count > 0) {
            holders.set(this.#path, count);
            return;
        }
        holders.delete(this.#path);
        if (isCurrentProcess(await this.#readOwner())) {
            await fs.rm(this.#path, { force: true });
        }
    }

    async #create() {
        const owner = {
            pid: process.pid,
            hostname: os.hostname(),
            startedAt: new Date().toISOString(),
        };
        // Write the content first and link it into place, so other processes
        // never observe an empty lock file.
        const temporary = `${this.#path}.${randomUUID()}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(owner)}\n`);
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    await fs.link(temporary, this.#path);
                    return;
                } catch (error) {
                    if (error.code !== 'EEXIST') throw error;
                }
                const existing = await this.#readOwner();
                if (isCurrentProcess(existing)) return;
                if (existing && isAlive(existing)) throw locked(existing);
                // left by a crashed process (or unreadable): take it over
                await fs.rm(this.#path, { force: true });
            }
            throw locked(await this.#readOwner());
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
}

function isCurrentProcess(owner) {
    return owner?.pid === process.pid && owner.hostname === os.hostname();
}

/**
 * @param {LockOwner} owner
 * @returns {boolean} False only if the owner is known to be dead
 */
function isAlive(owner) {
    // a process on another host cannot be checked, so it is assumed to be alive
    if (owner.hostname !== os.hostname()) return true;
    try {
        process.kill(owner.pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function locked(owner) {
    const by = owner
        ? `process ${owner.pid} on ${owner.hostname} (since ${owner.startedAt})`
        : 'another process';
    return new DatabaseError(
        `The database directory is already in use by ${by}.`,
        503,
        'DATABASE_LOCKED'
    );
}
