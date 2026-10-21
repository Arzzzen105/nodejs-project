import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileDatabase } from '../../src/storage/file-database.js';

describe('Filebase Engine', () => {
    const testDbPath = path.resolve(process.cwd(), 'tests', 'tmp-engine-db');
    let db;

    beforeEach(async () => {
        await fs.mkdir(testDbPath, { recursive: true });

        const mockSchemaPath = path.join(testDbPath, 'test-collection');
        await fs.mkdir(mockSchemaPath, { recursive: true });
        await fs.writeFile(
            path.join(mockSchemaPath, 'config.json'),
            JSON.stringify({
                table: 'test-collection',
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
            })
        );
        db = new FileDatabase(testDbPath);
        await db.init();
    });

    afterEach(async () => {
        //await fs.rm(testDbPath, { recursive: true, force: true });
    });

    test('after initialization engine has valid collection and its schema', async () => {
        expect(db.collections().includes('test-collection')).toBe(true);
    });

    test('creating a record with valid data should succeed', async () => {
        const recordData = {
            title: 'Test Record',
            description: 'This is a test record.',
            number: 42,
        };

        const createdRecord = await db.create('test-collection', recordData);
        expect(createdRecord).toHaveProperty('id');
        expect(createdRecord.title).toBe(recordData.title);
        expect(createdRecord.description).toBe(recordData.description);
        expect(createdRecord.number).toBe(recordData.number);
    });
});
