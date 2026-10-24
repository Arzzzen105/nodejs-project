import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    atomicWriteJson,
    removeFile,
    syncDirectory,
} from '../../src/storage/fs-utils.js';
import { createTempDir, removeDir, fileExists } from '../helpers/temp-db.js';

describe('fs-utils', () => {
    let root;

    beforeEach(async () => {
        root = await createTempDir();
    });

    afterEach(async () => {
        await removeDir(root);
    });

    describe('atomicWriteJson', () => {
        test('writes formatted JSON with a trailing newline', async () => {
            // ARRANGE
            const target = path.join(root, 'data.json');

            // ACT
            await atomicWriteJson(target, { a: 1 });

            // ASSERT
            expect(await fs.readFile(target, 'utf8')).toBe('{\n  "a": 1\n}\n');
        });

        test('replaces existing content', async () => {
            // ARRANGE
            const target = path.join(root, 'data.json');
            await atomicWriteJson(target, { version: 1 });

            // ACT
            await atomicWriteJson(target, { version: 2 });

            // ASSERT
            expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({
                version: 2,
            });
        });

        test('leaves no temporary files', async () => {
            // ACT
            await atomicWriteJson(path.join(root, 'data.json'), {});

            // ASSERT
            expect(await fs.readdir(root)).toEqual(['data.json']);
        });

        test('cleans up and rethrows when the write fails', async () => {
            // ARRANGE: renaming a file over a directory fails
            const target = path.join(root, 'occupied');
            await fs.mkdir(target);
            await fs.writeFile(path.join(target, 'keep'), '');

            // ACT & ASSERT
            await expect(atomicWriteJson(target, {})).rejects.toThrow();
            expect(await fs.readdir(root)).toEqual(['occupied']);
        });

        test('fails for a missing directory', async () => {
            // ACT & ASSERT
            await expect(
                atomicWriteJson(path.join(root, 'missing', 'data.json'), {})
            ).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });

    describe('removeFile', () => {
        test('removes an existing file', async () => {
            // ARRANGE
            const target = path.join(root, 'data.json');
            await fs.writeFile(target, '{}');

            // ACT & ASSERT
            await expect(removeFile(target)).resolves.toBe(true);
            expect(await fileExists(target)).toBe(false);
        });

        test('reports a missing file without failing', async () => {
            // ACT & ASSERT
            await expect(removeFile(path.join(root, 'nope'))).resolves.toBe(
                false
            );
        });
    });

    describe('syncDirectory', () => {
        test('succeeds for an existing directory', async () => {
            // ACT & ASSERT
            await expect(syncDirectory(root)).resolves.toBeUndefined();
        });

        test('fails for a missing directory', async () => {
            // ACT & ASSERT
            await expect(
                syncDirectory(path.join(root, 'missing'))
            ).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });
});
