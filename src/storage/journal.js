import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseError } from './errors.js';
import { atomicWriteJson, removeFile } from './fs-utils.js';
import { isPlainObject } from './validator.js';

const JOURNAL_FILE = 'journal.json';
const JOURNAL_VERSION = 1;

/**
 * Final state of one record after a transaction.
 * @typedef {object} JournalChange
 * @property {string} collection
 * @property {string} id
 * @property {object|null} record Full record to store, or null to delete it
 */

/**
 * Write-ahead journal that makes multi-record changes atomic.
 *
 * A commit first writes all changes to the journal (the commit point), then applies
 * them to record files and finally clears the journal. If the process stops in
 * between, the next start finds the journal and applies it again. Every change is
 * a full record or a delete, so applying it twice gives the same result as once.
 */
export class Journal {
    #root;
    #path;

    /**
     * @param {string} root Database root directory
     */
    constructor(root) {
        this.#root = root;
        this.#path = path.join(root, JOURNAL_FILE);
    }

    /** @returns {string} */
    get path() {
        return this.#path;
    }

    /**
     * Durably stores the changes. Once this resolves, the changes are committed.
     * @param {JournalChange[]} changes
     * @returns {Promise<void>}
     */
    async write(changes) {
        await atomicWriteJson(this.#path, {
            version: JOURNAL_VERSION,
            changes,
        });
    }

    /**
     * Returns changes of an unfinished commit, or null if there is none.
     * Also removes temporary files of journal writes interrupted before their commit point.
     * @returns {Promise<JournalChange[]|null>}
     */
    async recover() {
        await this.#removeStaleTemporaryFiles();

        let content;
        try {
            content = await fs.readFile(this.#path, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }

        let journal;
        try {
            journal = JSON.parse(content);
        } catch (error) {
            throw corrupt(`invalid JSON (${error.message})`);
        }
        if (
            !isPlainObject(journal) ||
            journal.version !== JOURNAL_VERSION ||
            !Array.isArray(journal.changes)
        ) {
            throw corrupt('unsupported format');
        }
        for (const change of journal.changes) {
            if (
                !isPlainObject(change) ||
                typeof change.collection !== 'string' ||
                typeof change.id !== 'string' ||
                !(change.record === null || isPlainObject(change.record))
            ) {
                throw corrupt('malformed change');
            }
        }
        return journal.changes;
    }

    /**
     * Removes the journal after its changes were applied.
     * @returns {Promise<void>}
     */
    async clear() {
        await removeFile(this.#path);
    }

    async #removeStaleTemporaryFiles() {
        const prefix = `${JOURNAL_FILE}.`;
        const entries = await fs.readdir(this.#root);
        await Promise.all(
            entries
                .filter(
                    (name) => name.startsWith(prefix) && name.endsWith('.tmp')
                )
                .map((name) =>
                    fs.rm(path.join(this.#root, name), { force: true })
                )
        );
    }
}

function corrupt(reason) {
    return new DatabaseError(
        `Cannot recover the transaction journal: ${reason}.`,
        500,
        'CORRUPT_JOURNAL'
    );
}
