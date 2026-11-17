import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseError, DatabaseErrors } from './errors.js';
import { atomicWriteJson, removeFile } from './fs-utils.js';
import { isPlainObject } from './validator.js';

const JOURNAL_FILE = 'journal.json';
// Version 1 held only the final states; it is still read, so a journal left by
// an older server is recovered after an upgrade (without a change log entry).
const JOURNAL_VERSION = 2;
const LEGACY_VERSION = 1;
const OPERATIONS = ['create', 'update', 'delete'];

/**
 * Final state of one record after a transaction, as it is applied to the files.
 * @typedef {object} JournalChange
 * @property {string} collection
 * @property {string} id
 * @property {object|null} record Full record to store, or null to delete it
 */

/**
 * Everything known about one commit: what the change log will record. The
 * journal stores it whole, so it is as durable as the commit itself.
 * @typedef {object} CommitEntry
 * @property {string} tx Transaction id (UUIDv7)
 * @property {string} at Commit time, ISO 8601
 * @property {object|null} context Who or what made the change, e.g. a request id
 * @property {Array<{ collection: string, id: string, op?: string, before?: object|null, after: object|null }>} changes
 *   `after` is the record to store, or null to delete it
 */

/**
 * What an unfinished commit left behind.
 * @typedef {object} RecoveredCommit
 * @property {CommitEntry|null} entry The commit, or null for a version 1 journal
 * @property {JournalChange[]} changes What to apply to the files
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
     * Durably stores a commit. Once this resolves, the changes are committed.
     * @param {CommitEntry} entry
     * @returns {Promise<void>}
     */
    async write(entry) {
        await atomicWriteJson(this.#path, {
            version: JOURNAL_VERSION,
            entry,
        });
    }

    /**
     * Returns an unfinished commit, or null if there is none.
     * Also removes temporary files of journal writes interrupted before their commit point.
     * @returns {Promise<RecoveredCommit|null>}
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
        if (isPlainObject(journal) && journal.version === LEGACY_VERSION) {
            return { entry: null, changes: legacyChanges(journal) };
        }
        if (!isPlainObject(journal) || journal.version !== JOURNAL_VERSION) {
            throw corrupt('unsupported format');
        }
        const entry = checkEntry(journal.entry);
        return {
            entry,
            changes: entry.changes.map(({ collection, id, after }) => ({
                collection,
                id,
                record: after,
            })),
        };
    }

    /**
     * Removes the journal after its changes were applied.
     * @returns {Promise<void>}
     */
    async clear() {
        await removeFile(this.#path);
    }

    /**
     * Removes journal writes that crashed before their rename, i.e. before
     * the commit point; such transactions never happened.
     * @returns {Promise<void>}
     */
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

/**
 * @param {*} entry `entry` of a version 2 journal
 * @returns {CommitEntry}
 */
function checkEntry(entry) {
    if (
        !isPlainObject(entry) ||
        typeof entry.tx !== 'string' ||
        typeof entry.at !== 'string' ||
        !(entry.context === null || isPlainObject(entry.context)) ||
        !Array.isArray(entry.changes)
    ) {
        throw corrupt('malformed commit');
    }
    for (const change of entry.changes) {
        if (
            !isPlainObject(change) ||
            typeof change.collection !== 'string' ||
            typeof change.id !== 'string' ||
            !isRecordOrNull(change.after) ||
            (change.before !== undefined && !isRecordOrNull(change.before)) ||
            (change.op !== undefined && !OPERATIONS.includes(change.op))
        ) {
            throw corrupt('malformed change');
        }
    }
    return entry;
}

/**
 * @param {object} journal A version 1 journal
 * @returns {JournalChange[]}
 */
function legacyChanges(journal) {
    if (!Array.isArray(journal.changes)) throw corrupt('unsupported format');
    for (const change of journal.changes) {
        if (
            !isPlainObject(change) ||
            typeof change.collection !== 'string' ||
            typeof change.id !== 'string' ||
            !isRecordOrNull(change.record)
        ) {
            throw corrupt('malformed change');
        }
    }
    return journal.changes;
}

/**
 * @param {*} value
 * @returns {boolean} True for a record object or null
 */
function isRecordOrNull(value) {
    return value === null || isPlainObject(value);
}

/**
 * @param {string} reason
 * @returns {DatabaseError} CORRUPT_JOURNAL
 */
function corrupt(reason) {
    return new DatabaseError(
        DatabaseErrors.CORRUPT_JOURNAL,
        `Cannot recover the transaction journal: ${reason}.`
    );
}
