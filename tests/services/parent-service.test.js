import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import path from 'node:path';
import { FileDatabase } from '../../src/storage/file-database.js';
import { createContainer } from '../../src/container.js';
import { copySchema } from '../../scripts/copy-schema.js';
import { createTempDir, removeDir } from '../helpers/temp-db.js';

const SCHEMA = path.resolve(import.meta.dirname, '..', '..', 'database');

describe('ParentService', () => {
    let root;
    let db;
    let parents;
    let repositories;

    beforeEach(async () => {
        root = await createTempDir();
        await copySchema(SCHEMA, root);
        db = await new FileDatabase(root).init();
        const container = createContainer(db);
        repositories = container.repositories;
        parents = container.services.parents;
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    const parent = (sex = 'FEMALE') => ({
        firstName: 'Олена',
        lastName: 'Коваль',
        sex,
    });
    /** A kid of the parent in the given role, through the repository. */
    const kidOf = (role, parentId) =>
        repositories.kids.create({
            firstName: 'Марко',
            lastName: 'Коваль',
            age: 3,
            sex: 'MALE',
            [role]: parentId,
        });

    describe('the sex of a parent of a kid (BR-12)', () => {
        test.each([
            ['mother', 'motherId', 'FEMALE', 'MALE'],
            ['father', 'fatherId', 'MALE', 'FEMALE'],
        ])(
            'update cannot change the sex of a %s',
            async (name, role, sex, other) => {
                // ARRANGE
                const { id } = await parents.create(parent(sex));
                await kidOf(role, id);

                // ACT
                const write = parents.update(id, { sex: other });

                // ASSERT
                await expect(write).rejects.toMatchObject({
                    status: 409,
                    code: 'PARENT_SEX_LOCKED',
                });
                expect((await parents.get(id)).sex).toBe(sex);
            }
        );

        test('replace cannot change it either', async () => {
            const { id } = await parents.create(parent('FEMALE'));
            await kidOf('motherId', id);

            await expect(
                parents.replace(id, parent('MALE'))
            ).rejects.toMatchObject({ code: 'PARENT_SEX_LOCKED' });
        });

        test('other fields of the parent still change', async () => {
            const { id } = await parents.create(parent('FEMALE'));
            await kidOf('motherId', id);

            await expect(
                parents.update(id, { firstName: 'Оксана', sex: 'FEMALE' })
            ).resolves.toMatchObject({ firstName: 'Оксана', sex: 'FEMALE' });
            await expect(
                parents.replace(id, { ...parent('FEMALE'), lastName: 'Бойко' })
            ).resolves.toMatchObject({ lastName: 'Бойко' });
        });

        test('the sex of a parent without kids changes', async () => {
            const { id } = await parents.create(parent('FEMALE'));

            await expect(
                parents.update(id, { sex: 'MALE' })
            ).resolves.toMatchObject({ sex: 'MALE' });
        });

        test('changes once the last kid is gone', async () => {
            const { id } = await parents.create(parent('FEMALE'));
            const kid = await kidOf('motherId', id);
            await repositories.kids.update(kid.id, { motherId: null });

            await expect(
                parents.update(id, { sex: 'MALE' })
            ).resolves.toMatchObject({ sex: 'MALE' });
        });
    });

    test('answers 404 for a missing parent', async () => {
        await expect(
            parents.update('01900000-0000-7000-8000-000000000000', {
                sex: 'MALE',
            })
        ).rejects.toMatchObject({ status: 404 });
    });
});
