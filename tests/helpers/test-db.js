import fs from 'node:fs/promises';
import path from 'node:path';
import { FileDatabase } from '../../src/storage/file-database.js';
import { copySchema } from '../../scripts/copy-schema.js';

const ACTUAL_DB_PATH =
    process.env.DATABASE_DIR ?? path.resolve(process.cwd(), 'database');

export async function setupTestDatabase(dbName = 'test-db') {
    const testDbPath = path.resolve(process.cwd(), 'tests', dbName);

    await cleanupTestDatabase(testDbPath);

    await copySchema(ACTUAL_DB_PATH, testDbPath);

    const db = new FileDatabase(testDbPath);
    await db.init();

    return { db, testDbPath };
}

export async function cleanupTestDatabase(testDbPath = 'test-db') {
    await fs.rm(testDbPath, { recursive: true, force: true });
}
