import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createTempDir, removeDir, fileExists } from '../helpers/temp-db.js';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');

/** @returns {Promise<number>} A port nothing listens on */
function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

/**
 * Starts scripts/dev.js on a temporary dev database.
 * @returns {{ child: import('node:child_process').ChildProcess, exited: Promise<number>, stderr: () => string }}
 */
function startDev(devDir, port) {
    const child = spawn(process.execPath, ['scripts/dev.js'], {
        cwd: projectRoot,
        env: { ...process.env, PORT: String(port), DEV_DATABASE_DIR: devDir },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const exited = new Promise((resolve) => child.on('exit', resolve));
    return { child, exited, stderr: () => stderr };
}

async function waitForHealth(port) {
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.ok) return;
        } catch {
            // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The dev server did not start.');
}

describe('scripts/dev.js', { timeout: 20000 }, () => {
    let parent;
    let devDir;
    let running = [];

    beforeEach(async () => {
        parent = await createTempDir();
        devDir = path.join(parent, 'dev-db');
    });

    afterEach(async () => {
        for (const { child, exited } of running) {
            if (child.exitCode === null) child.kill('SIGTERM');
            await exited;
        }
        running = [];
        await removeDir(parent);
    });

    test('runs the server on a copy of the schema and removes it on SIGTERM', async () => {
        // ARRANGE: a leftover of a session that could not clean up
        await fs.mkdir(path.join(devDir, 'kids'), { recursive: true });
        await fs.writeFile(path.join(devDir, 'kids', 'stale.json'), '{}');
        const port = await freePort();

        // ACT
        const dev = startDev(devDir, port);
        running.push(dev);
        await waitForHealth(port);

        // ASSERT: a fresh copy of every collection of database/, without records
        const schema = (
            await fs.readdir(path.join(projectRoot, 'database'), {
                withFileTypes: true,
            })
        )
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
        const copied = (await fs.readdir(devDir)).filter(
            (name) => !name.startsWith('.')
        );
        expect(copied.sort()).toEqual(schema);
        expect(await fileExists(path.join(devDir, 'kids', 'stale.json'))).toBe(
            false
        );
        expect(await fileExists(path.join(devDir, '.lock'))).toBe(true);

        dev.child.kill('SIGTERM');
        expect(await dev.exited).toBe(0);
        expect(await fileExists(devDir)).toBe(false);
        expect(dev.stderr()).toContain('Dev database removed.');
    });

    test('refuses to start while another dev session uses the directory', async () => {
        // ARRANGE
        const port = await freePort();
        const first = startDev(devDir, port);
        running.push(first);
        await waitForHealth(port);

        // ACT
        const second = startDev(devDir, await freePort());
        running.push(second);

        // ASSERT
        expect(await second.exited).toBe(1);
        expect(second.stderr()).toContain('is used by a running dev server');
        await waitForHealth(port);
        expect(await fileExists(path.join(devDir, '.lock'))).toBe(true);
    });
});
