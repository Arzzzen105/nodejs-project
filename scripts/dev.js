// Development server on a throwaway database. The schema of database/ is copied
// into .dev-db/, the server runs on it with node --watch, and the copy is removed
// when the session ends, so manual testing always starts from an empty database
// and never touches the real one.
//
// The database lives as long as this script, not the server: node --watch
// restarts the server on every saved file, and the data must survive that.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { copySchema } from './copy-schema.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const schemaDir = path.join(projectRoot, 'database');
const devDir = path.resolve(
    process.env.DEV_DATABASE_DIR ?? path.join(projectRoot, '.dev-db')
);

/** Messages go to stderr: stdout carries the server's JSON logs to pino-pretty. */
function say(message) {
    console.error(`[dev] ${message}`);
}

/**
 * @returns {Promise<number|null>} PID of a running server that holds the dev
 *   database (from its lock file), or null
 */
async function liveOwner() {
    try {
        const { pid } = JSON.parse(
            await fs.readFile(path.join(devDir, '.lock'), 'utf8')
        );
        process.kill(pid, 0);
        return pid;
    } catch {
        return null;
    }
}

const owner = await liveOwner();
if (owner !== null) {
    say(
        `${devDir} is used by a running dev server (process ${owner}). Stop it first.`
    );
    process.exit(1);
}
// a session killed with SIGKILL or a closed terminal could not clean up
await fs.rm(devDir, { recursive: true, force: true });
const collections = await copySchema(schemaDir, devDir);
const shown = devDir.startsWith(projectRoot + path.sep)
    ? path.relative(projectRoot, devDir)
    : devDir;
say(
    `Empty database with ${collections.length} collections in ${shown}; it is removed when you stop the server.`
);

const server = spawn(
    process.execPath,
    ['--watch', path.join('src', 'server.js')],
    {
        cwd: projectRoot,
        stdio: 'inherit',
        env: { ...process.env, DATABASE_DIR: devDir },
    }
);

// Ctrl+C reaches the whole process group, but a signal from an IDE or `kill`
// reaches this script only, so it is passed on. node --watch forwards it to the
// server and waits until the server has closed the database.
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.kill(signal));
}

server.on('exit', async (code, signal) => {
    if ((await liveOwner()) !== null) {
        say(`The server still holds ${devDir}, so it was left in place.`);
    } else {
        await fs.rm(devDir, { recursive: true, force: true });
        say('Dev database removed.');
    }
    process.exit(code ?? (signal === null ? 0 : 1));
});
