// Empties a database directory: every record, the history of changes and an
// unfinished journal go; the schema of each collection (<collection>/config.json)
// stays. For the real database of npm start: npm run dev starts from an empty
// copy every time anyway.
//
//     npm run db:clear              # asks before deleting
//     npm run db:clear -- --dry-run # only tells what it would delete
//     npm run db:clear -- --yes     # does not ask
//
// The directory is DATABASE_DIR (default ./database), as for the server. It
// takes the lock of the database while it works, so it refuses while a server
// uses the directory, and no server starts on it meanwhile.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ProcessLock } from '../src/storage/process-lock.js';

const CONFIG = 'config.json';
/** The history of changes (src/storage/change-log.js). */
const HISTORY = '.changes';
/** Files of the root left by an unfinished commit or lock. */
const LEFTOVERS = /^(journal\.json(\..+\.tmp)?|\.lock\..+\.tmp)$/;

/**
 * @typedef {object} ClearReport
 * @property {Array<{ name: string, records: number }>} collections Sorted
 * @property {number} records In all
 * @property {number} history Files of the history of changes
 * @property {string[]} leftovers Journal and temporary files of the root
 */

/**
 * Deletes every record of a database directory, its history of changes and
 * an unfinished journal; keeps `<collection>/config.json`. A directory
 * without a config.json is not a collection, and files of the root it does
 * not know are left alone.
 * @param {string} root Database directory
 * @param {object} [options]
 * @param {boolean} [options.dryRun] Only tell what would be deleted
 * @returns {Promise<ClearReport>} What was (or would be) deleted
 * @throws {DatabaseError} DATABASE_LOCKED while a server uses the directory
 */
export async function clearDatabase(root, { dryRun = false } = {}) {
    // a dry run changes nothing, so it may look while a server runs
    const lock = dryRun ? null : new ProcessLock(root);
    await lock?.acquire();
    try {
        const report = await survey(root);
        if (!dryRun) {
            for (const { name } of report.collections) {
                const directory = path.join(root, name);
                for (const file of await fs.readdir(directory)) {
                    if (file !== CONFIG) {
                        await fs.rm(path.join(directory, file), {
                            recursive: true,
                            force: true,
                        });
                    }
                }
            }
            await fs.rm(path.join(root, HISTORY), {
                recursive: true,
                force: true,
            });
            for (const file of report.leftovers) {
                await fs.rm(path.join(root, file), { force: true });
            }
        }
        return report;
    } finally {
        await lock?.release();
    }
}

/** What there is to delete. */
async function survey(root) {
    const collections = [];
    const leftovers = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (entry.isFile() && LEFTOVERS.test(entry.name)) {
            leftovers.push(entry.name);
        }
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const files = await fs.readdir(path.join(root, entry.name));
        if (!files.includes(CONFIG)) continue;
        collections.push({
            name: entry.name,
            records: files.filter((file) => file !== CONFIG).length,
        });
    }
    collections.sort((a, b) => a.name.localeCompare(b.name));
    let history = 0;
    try {
        history = (await fs.readdir(path.join(root, HISTORY))).length;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    return {
        collections,
        records: collections.reduce((sum, c) => sum + c.records, 0),
        history,
        leftovers: leftovers.sort(),
    };
}

/** What the report says, for people. */
function describe(report) {
    const filled = report.collections.filter((c) => c.records > 0);
    return [
        `${report.records} record(s)` +
            (filled.length
                ? `: ${filled.map((c) => `${c.name} ${c.records}`).join(', ')}`
                : ''),
        `${report.history} file(s) of the history of changes`,
        ...(report.leftovers.length
            ? [`leftovers: ${report.leftovers.join(', ')}`]
            : []),
    ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const say = (message) => console.log(`[db:clear] ${message}`);
    try {
        const { values } = parseArgs({
            options: {
                yes: { type: 'boolean', short: 'y' },
                'dry-run': { type: 'boolean' },
            },
        });
        const root = path.resolve(
            process.env.DATABASE_DIR ?? path.join(process.cwd(), 'database')
        );
        const planned = await clearDatabase(root, { dryRun: true });
        say(`Database: ${root}`);
        for (const line of describe(planned)) say(`  ${line}`);

        if (values['dry-run']) {
            say('Dry run: nothing deleted.');
        } else if (planned.records === 0 && planned.history === 0) {
            say('Already empty.');
        } else {
            let sure = values.yes;
            if (!sure) {
                if (!process.stdin.isTTY) {
                    throw new Error(
                        'Not a terminal: pass --yes to delete without asking.'
                    );
                }
                const prompt = createInterface({
                    input: process.stdin,
                    output: process.stdout,
                });
                const answer = await prompt.question(
                    '[db:clear] Delete all of it? The schemas stay. Type "yes": '
                );
                prompt.close();
                sure = answer.trim().toLowerCase() === 'yes';
            }
            if (sure) {
                const report = await clearDatabase(root);
                say(
                    `Deleted ${report.records} record(s) and the history of changes; ${report.collections.length} collection schemas kept.`
                );
            } else {
                say('Nothing deleted.');
            }
        }
    } catch (error) {
        console.error(`[db:clear] ${error.message}`);
        process.exitCode = 1;
    }
}
