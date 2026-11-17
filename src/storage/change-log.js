import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseError, DatabaseErrors } from './errors.js';
import { syncDirectory } from './fs-utils.js';
import { isPlainObject } from './validator.js';

// A dot keeps the directory apart from collections: the loader skips names that
// are not valid collection names, so it can never be mistaken for one.
const DIRECTORY = '.changes';
const SEGMENT = /^changes-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Append-only log of committed changes, one JSON line per transaction, in a
 * file per UTC day: `<root>/.changes/changes-2026-11-17.jsonl`. Files are never
 * removed or rewritten, except that a line torn by a crash is cut off on start.
 *
 * The log only stores lines. What a line contains and when it is written (once
 * per commit, never twice) is decided by the transaction manager.
 */
export class ChangeLog {
    #root;
    #directory;
    #now;

    /**
     * @param {string} root Database root directory
     * @param {object} [options]
     * @param {() => Date} [options.now] Clock that picks the file of the day; for tests
     */
    constructor(root, options) {
        this.#root = root;
        this.#directory = path.join(root, DIRECTORY);
        this.#now = options?.now ?? (() => new Date());
    }

    /** @returns {string} Directory with the log files */
    get directory() {
        return this.#directory;
    }

    /**
     * Durably appends one entry as a line to the file of the current UTC day.
     * Once this resolves, the line is on disk.
     * @param {{ tx: string }} entry JSON-serializable, with the transaction id in `tx`
     * @returns {Promise<void>}
     */
    async append(entry) {
        if (!isPlainObject(entry) || typeof entry.tx !== 'string') {
            throw new TypeError('A change log entry needs a string "tx".');
        }
        // JSON.stringify escapes line breaks inside strings, so a line is one entry
        const line = `${JSON.stringify(entry)}\n`;
        const file = path.join(this.#directory, segmentName(this.#now()));

        const createdDirectory = await this.#ensureDirectory();
        const createdFile = !(await exists(file));
        const handle = await fs.open(file, 'a');
        try {
            await handle.writeFile(line, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        if (createdFile) await syncDirectory(this.#directory);
        if (createdDirectory) await syncDirectory(this.#root);
    }

    /**
     * Prepares the log after a start: cuts off a last line that a crash left
     * incomplete and reports the transaction of the last complete line, so a
     * commit recovered from the journal is appended only if it is not there yet.
     * @returns {Promise<string|null>} `tx` of the last entry, or null if the log is empty
     * @throws {DatabaseError} CORRUPT_CHANGE_LOG if a complete line is not a valid entry
     */
    async repairTail() {
        const segments = await this.#segments();
        for (const name of segments.reverse()) {
            const file = path.join(this.#directory, name);
            const content = await fs.readFile(file, 'utf8');
            const end = content.lastIndexOf('\n') + 1;
            if (end < content.length) {
                // the last write was interrupted before its line was complete
                await fs.truncate(
                    file,
                    Buffer.byteLength(content.slice(0, end))
                );
                await syncFile(file);
            }
            const lines = content.slice(0, end).split('\n');
            lines.pop();
            if (lines.length > 0) {
                return parseLine(lines.at(-1), name, lines.length).tx;
            }
        }
        return null;
    }

    /**
     * Reads every entry, oldest first.
     * @returns {AsyncGenerator<object>}
     * @throws {DatabaseError} CORRUPT_CHANGE_LOG for a line that is not a valid entry
     */
    async *entries() {
        for (const name of await this.#segments()) {
            const lines = createInterface({
                input: createReadStream(path.join(this.#directory, name), {
                    encoding: 'utf8',
                }),
                crlfDelay: Infinity,
            });
            let number = 0;
            for await (const line of lines) {
                number++;
                if (line === '') continue;
                yield parseLine(line, name, number);
            }
        }
    }

    /**
     * @returns {Promise<string[]>} Names of the log files, oldest first
     */
    async #segments() {
        let names;
        try {
            names = await fs.readdir(this.#directory);
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
        // the date in the name is ISO, so name order is time order
        return names.filter((name) => SEGMENT.test(name)).sort();
    }

    /**
     * @returns {Promise<boolean>} Whether the directory had to be created
     */
    async #ensureDirectory() {
        if (await exists(this.#directory)) return false;
        await fs.mkdir(this.#directory, { recursive: true });
        return true;
    }
}

/**
 * @param {Date} date
 * @returns {string} e.g. "changes-2026-11-17.jsonl" (UTC day)
 */
function segmentName(date) {
    return `changes-${date.toISOString().slice(0, 10)}.jsonl`;
}

/**
 * @param {string} line
 * @param {string} file For the error message
 * @param {number} number Line number, for the error message
 * @returns {{ tx: string }}
 */
function parseLine(line, file, number) {
    let entry;
    try {
        entry = JSON.parse(line);
    } catch {
        entry = null;
    }
    if (!isPlainObject(entry) || typeof entry.tx !== 'string') {
        throw new DatabaseError(
            DatabaseErrors.CORRUPT_CHANGE_LOG,
            `Line ${number} of ${file} in the change log is not a valid entry.`
        );
    }
    return entry;
}

/**
 * @param {string} target
 * @returns {Promise<boolean>}
 */
async function exists(target) {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}

/**
 * @param {string} file
 * @returns {Promise<void>}
 */
async function syncFile(file) {
    const handle = await fs.open(file, 'r+');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}
