import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Platforms that cannot open or fsync a directory (e.g. Windows) report one of these.
const UNSUPPORTED_DIRECTORY_SYNC = new Set([
    'EISDIR',
    'EPERM',
    'EINVAL',
    'EBADF',
]);

/**
 * Flushes directory entries (created, renamed or removed files) to disk.
 * Without it a rename may be lost on power failure even if the file itself was synced.
 * @param {string} directory
 * @returns {Promise<void>}
 */
export async function syncDirectory(directory) {
    let handle;
    try {
        handle = await fs.open(directory, 'r');
        await handle.sync();
    } catch (error) {
        if (!UNSUPPORTED_DIRECTORY_SYNC.has(error.code)) throw error;
    } finally {
        await handle?.close();
    }
}

/**
 * Atomically writes a JSON file: writes to a temporary file, flushes it to disk,
 * renames it over the target and flushes the directory.
 * Readers see either the old or the new content, never a partial file.
 * @param {string} target Destination file path
 * @param {*} data JSON-serializable value
 * @returns {Promise<void>}
 */
export async function atomicWriteJson(target, data) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await fs.open(temporary, 'wx');
        await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporary, target);
    } catch (error) {
        if (handle) {
            await handle.close().catch(() => {});
        }
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
    await syncDirectory(path.dirname(target));
}

/**
 * Removes a file if it exists and flushes the directory.
 * @param {string} target
 * @returns {Promise<boolean>} true if the file existed
 */
export async function removeFile(target) {
    try {
        await fs.unlink(target);
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
    await syncDirectory(path.dirname(target));
    return true;
}
