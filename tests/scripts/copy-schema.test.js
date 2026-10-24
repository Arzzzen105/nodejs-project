import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { copySchema } from '../../scripts/copy-schema.js';
import { createTempDir, removeDir } from '../helpers/temp-db.js';

describe('copySchema', () => {
    let source;
    let target;

    beforeEach(async () => {
        source = await createTempDir();
        target = path.join(await createTempDir(), 'copy');
        for (const name of ['kids', 'groups']) {
            await fs.mkdir(path.join(source, name));
            await fs.writeFile(
                path.join(source, name, 'config.json'),
                `{"table":"${name}"}`
            );
        }
        // records, the journal, the lock and a directory without a config
        await fs.writeFile(path.join(source, 'kids', '0190-record.json'), '{}');
        await fs.writeFile(path.join(source, 'journal.json'), '{}');
        await fs.writeFile(path.join(source, '.lock'), '{}');
        await fs.mkdir(path.join(source, 'drafts'));
    });

    afterEach(async () => {
        await removeDir(source);
        await removeDir(path.dirname(target));
    });

    test('copies only collection configs', async () => {
        // ACT
        const copied = await copySchema(source, target);

        // ASSERT
        expect(copied).toEqual(['groups', 'kids']);
        expect((await fs.readdir(target)).sort()).toEqual(['groups', 'kids']);
        expect(await fs.readdir(path.join(target, 'kids'))).toEqual([
            'config.json',
        ]);
        expect(
            await fs.readFile(
                path.join(target, 'groups', 'config.json'),
                'utf8'
            )
        ).toBe('{"table":"groups"}');
    });

    test('creates the target and leaves the source untouched', async () => {
        // ACT
        await copySchema(source, target);

        // ASSERT
        expect((await fs.readdir(path.join(source, 'kids'))).sort()).toEqual([
            '0190-record.json',
            'config.json',
        ]);
    });
});
