import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import path from 'node:path';
import { FileDatabase } from '../../src/storage/file-database.js';
import { createContainer } from '../../src/container.js';
import { MAX_GROUPS } from '../../src/services/group-service.js';
import { copySchema } from '../../scripts/copy-schema.js';
import { createTempDir, removeDir } from '../helpers/temp-db.js';

const SCHEMA = path.resolve(import.meta.dirname, '..', '..', 'database');

describe('GroupService', () => {
    let root;
    let db;
    let groups;
    let repositories;

    beforeEach(async () => {
        root = await createTempDir();
        await copySchema(SCHEMA, root);
        db = await new FileDatabase(root).init();
        const container = createContainer(db);
        repositories = container.repositories;
        groups = container.services.groups;
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    let counter = 0;
    /** Adds groups through the repository, past the rules. */
    const fill = async (count) => {
        for (let i = 0; i < count; i++) {
            await repositories.groups.create({
                name: `Group ${++counter}`,
                age: 3,
            });
        }
    };

    describe('create (BR-19)', () => {
        test(`takes the group up to ${MAX_GROUPS}`, async () => {
            await fill(MAX_GROUPS - 1);

            await groups.create({ name: 'Остання', age: 3 });

            expect(await repositories.groups.count()).toBe(MAX_GROUPS);
        });

        test(`rejects group ${MAX_GROUPS + 1}`, async () => {
            await fill(MAX_GROUPS);

            await expect(
                groups.create({ name: 'Зайва', age: 3 })
            ).rejects.toMatchObject({
                status: 409,
                code: 'GROUP_LIMIT_REACHED',
            });
            expect(await repositories.groups.count()).toBe(MAX_GROUPS);
        });

        test('takes a new group once one is deleted', async () => {
            await fill(MAX_GROUPS);
            const [first] = (await repositories.groups.findPage()).items;
            await groups.delete(first.id);

            await expect(
                groups.create({ name: 'Нова', age: 3 })
            ).resolves.toMatchObject({ name: 'Нова' });
        });

        test('two creates at once cannot both take the last place', async () => {
            await fill(MAX_GROUPS - 1);

            const results = await Promise.allSettled([
                groups.create({ name: 'Перша', age: 3 }),
                groups.create({ name: 'Друга', age: 3 }),
            ]);

            expect(results.map(({ status }) => status).sort()).toEqual([
                'fulfilled',
                'rejected',
            ]);
            expect(await repositories.groups.count()).toBe(MAX_GROUPS);
        });
    });

    test('changes a group when there are already as many as allowed', async () => {
        await fill(MAX_GROUPS - 1);
        const { id } = await groups.create({ name: 'Сонечко', age: 3 });

        await expect(
            groups.update(id, { name: 'Зайчики' })
        ).resolves.toMatchObject({ name: 'Зайчики' });
        await expect(
            groups.replace(id, { name: 'Білочки', age: 4 })
        ).resolves.toMatchObject({ name: 'Білочки', age: 4 });
    });
});
