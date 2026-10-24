import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Copies collection configs (`<collection>/config.json`) from one database
 * directory to another without their records, so the copy has the same schema
 * and starts empty.
 * @param {string} source Database directory to copy the schema from
 * @param {string} target Created if missing
 * @returns {Promise<string[]>} Names of the copied collections, sorted
 */
export async function copySchema(source, target) {
    await fs.mkdir(target, { recursive: true });
    const copied = [];
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const config = path.join(source, entry.name, 'config.json');
        try {
            await fs.access(config);
        } catch {
            continue;
        }
        const directory = path.join(target, entry.name);
        await fs.mkdir(directory, { recursive: true });
        await fs.copyFile(config, path.join(directory, 'config.json'));
        copied.push(entry.name);
    }
    return copied.sort();
}
