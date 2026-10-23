import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const TEST_COLLECTION = 'test-collection';

/**
 * Returns a fresh config for the test collection.
 * A new object every time, because validateConfig() and Collection keep references to it.
 */
export function createTestConfig() {
    return {
        table: TEST_COLLECTION,
        primaryKey: 'id',
        columns: {
            title: { type: 'string', required: true },
            description: { type: 'string', required: false },
            number: {
                type: 'integer',
                required: false,
                min: 0,
                max: 100,
            },
        },
        indexes: ['title'],
    };
}

/**
 * Creates a unique temporary directory, so test files can run in parallel.
 * @returns {Promise<string>}
 */
export async function createTempDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'filebase-test-'));
}

export async function removeDir(directory) {
    await fs.rm(directory, { recursive: true, force: true });
}

/**
 * Creates `<root>/<name>/config.json` and returns the collection directory.
 * @param {string} root
 * @param {string} name
 * @param {object|string} config Config object, or raw file content
 * @returns {Promise<string>}
 */
export async function writeCollectionConfig(root, name, config) {
    const directory = path.join(root, name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
        path.join(directory, 'config.json'),
        typeof config === 'string' ? config : JSON.stringify(config)
    );
    return directory;
}

export async function fileExists(filePath) {
    return fs
        .access(filePath)
        .then(() => true)
        .catch(() => false);
}
