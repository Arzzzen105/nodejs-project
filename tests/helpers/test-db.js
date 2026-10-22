import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FileDatabase } from '../../src/storage/file-database.js';

const ACTUAL_DB_PATH =
    process.env.DATABASE_DIR ?? path.resolve(process.cwd(), 'database');

export async function setupTestDatabase(dbName = 'test-db') {
    const testDbPath = path.resolve(process.cwd(), 'tests', dbName);

    await cleanupTestDatabase(testDbPath);

    await copyActualSchema(testDbPath);

    const db = new FileDatabase(testDbPath);
    await db.init();

    return { db, testDbPath };
}

async function copyActualSchema(testDbPath = 'test-db') {
    const entries = await fs.readdir(ACTUAL_DB_PATH, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const configPath = path.join(ACTUAL_DB_PATH, entry.name, 'config.json');
        if (existsSync(configPath)) {
            const targetDir = path.join(testDbPath, entry.name);
            await fs.mkdir(targetDir, { recursive: true });
            await fs.copyFile(configPath, path.join(targetDir, 'config.json'));
        }
    }
}

export async function cleanupTestDatabase(testDbPath = 'test-db') {
    await fs.rm(testDbPath, { recursive: true, force: true });
}
