import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import path from 'node:path';
import { FileDatabase } from '../../src/storage/file-database.js';
import { createContainer } from '../../src/container.js';
import { MAX_GROUP_SIZE } from '../../src/services/kid-service.js';
import { copySchema } from '../../scripts/copy-schema.js';
import { createTempDir, removeDir } from '../helpers/temp-db.js';

const SCHEMA = path.resolve(import.meta.dirname, '..', '..', 'database');

describe('KidService', () => {
    let root;
    let db;
    let kids;
    let repositories;

    beforeEach(async () => {
        root = await createTempDir();
        await copySchema(SCHEMA, root);
        db = await new FileDatabase(root).init();
        const container = createContainer(db);
        repositories = container.repositories;
        kids = container.services.kids;
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    let counter = 0;
    const group = (age = 3) =>
        repositories.groups.create({ name: `Group ${++counter}`, age });
    const parent = (sex) =>
        repositories.parents.create({
            firstName: 'Олена',
            lastName: 'Коваль',
            sex,
        });
    const kid = (fields = {}) => ({
        firstName: 'Марко',
        lastName: 'Коваль',
        age: 3,
        sex: 'MALE',
        ...fields,
    });
    /** Fills a group up to `count` kids through the repository, past the rules. */
    const fill = async (groupId, count) => {
        for (let i = 0; i < count; i++) {
            await repositories.kids.create(kid({ groupId }));
        }
    };

    describe('create', () => {
        test('accepts a kid with a fitting mother, father and group', async () => {
            // ARRANGE
            const mother = await parent('FEMALE');
            const father = await parent('MALE');
            const { id: groupId } = await group(3);

            // ACT
            const created = await kids.create(
                kid({ motherId: mother.id, fatherId: father.id, groupId })
            );

            // ASSERT
            expect(await kids.get(created.id)).toMatchObject({
                motherId: mother.id,
                fatherId: father.id,
                groupId,
            });
        });

        test('rejects a mother who is not FEMALE, and stores nothing', async () => {
            const { id: motherId } = await parent('MALE');

            await expect(kids.create(kid({ motherId }))).rejects.toMatchObject({
                status: 422,
                code: 'MOTHER_NOT_FEMALE',
            });
            expect((await kids.list()).total).toBe(0);
        });

        test('rejects a father who is not MALE', async () => {
            const { id: fatherId } = await parent('FEMALE');

            await expect(kids.create(kid({ fatherId }))).rejects.toMatchObject({
                status: 422,
                code: 'FATHER_NOT_MALE',
            });
        });

        test('rejects a group of another age', async () => {
            const { id: groupId } = await group(4);

            await expect(
                kids.create(kid({ age: 3, groupId }))
            ).rejects.toMatchObject({
                status: 422,
                code: 'GROUP_AGE_MISMATCH',
            });
        });

        test('rejects a full group', async () => {
            const { id: groupId } = await group();
            await fill(groupId, MAX_GROUP_SIZE);

            await expect(kids.create(kid({ groupId }))).rejects.toMatchObject({
                status: 409,
                code: 'GROUP_FULL',
            });
            expect(await repositories.kids.countByGroup(groupId)).toBe(
                MAX_GROUP_SIZE
            );
        });

        test('takes the last place of a group', async () => {
            const { id: groupId } = await group();
            await fill(groupId, MAX_GROUP_SIZE - 1);

            await kids.create(kid({ groupId }));

            expect(await repositories.kids.countByGroup(groupId)).toBe(
                MAX_GROUP_SIZE
            );
        });

        test('two kids racing for the last place: only one gets it', async () => {
            // ARRANGE
            const { id: groupId } = await group();
            await fill(groupId, MAX_GROUP_SIZE - 1);

            // ACT
            const results = await Promise.allSettled([
                kids.create(kid({ groupId })),
                kids.create(kid({ groupId })),
            ]);

            // ASSERT
            expect(results.map((result) => result.status).sort()).toEqual([
                'fulfilled',
                'rejected',
            ]);
            expect(await repositories.kids.countByGroup(groupId)).toBe(
                MAX_GROUP_SIZE
            );
        });

        test('leaves a missing parent or group to the database', async () => {
            const missing = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

            await expect(
                kids.create(kid({ motherId: missing }))
            ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
            await expect(
                kids.create(kid({ groupId: missing }))
            ).rejects.toMatchObject({ code: 'REFERENCE_NOT_FOUND' });
        });
    });

    describe('update', () => {
        test('moves a kid into a group by groupId alone', async () => {
            const { id } = await kids.create(kid({ age: 3 }));
            const { id: groupId } = await group(3);

            expect(await kids.update(id, { groupId })).toMatchObject({
                groupId,
            });
        });

        test('rejects an age that no longer fits the group', async () => {
            const { id: groupId } = await group(3);
            const { id } = await kids.create(kid({ age: 3, groupId }));

            await expect(kids.update(id, { age: 4 })).rejects.toMatchObject({
                code: 'GROUP_AGE_MISMATCH',
            });
            expect((await kids.get(id)).age).toBe(3);
        });

        test('changes a kid of a full group: they already have their place', async () => {
            const { id: groupId } = await group();
            await fill(groupId, MAX_GROUP_SIZE - 1);
            const { id } = await kids.create(kid({ groupId }));

            expect(
                await kids.update(id, { firstName: 'Остап', groupId })
            ).toMatchObject({ firstName: 'Остап' });
        });

        test('rejects moving into a full group', async () => {
            const { id: full } = await group();
            await fill(full, MAX_GROUP_SIZE);
            const { id } = await kids.create(kid());

            await expect(
                kids.update(id, { groupId: full })
            ).rejects.toMatchObject({ code: 'GROUP_FULL' });
        });

        test('changes the age of a kid of a full group to its age', async () => {
            // ARRANGE: the group got older after the kids were added
            const { id: groupId } = await group(3);
            await fill(groupId, MAX_GROUP_SIZE - 1);
            const { id } = await kids.create(kid({ age: 3, groupId }));
            await repositories.groups.update(groupId, { age: 4 });

            // ACT
            const updated = await kids.update(id, { age: 4 });

            // ASSERT
            expect(updated).toMatchObject({ age: 4, groupId });
        });

        test('does not check again what the write keeps', async () => {
            // ARRANGE: the mother's record changes after the kid was created
            const mother = await parent('FEMALE');
            const { id } = await kids.create(kid({ motherId: mother.id }));
            await repositories.parents.update(mother.id, { sex: 'MALE' });

            // ACT
            const updated = await kids.update(id, { firstName: 'Остап' });

            // ASSERT
            expect(updated.firstName).toBe('Остап');
        });

        test('rejects a new mother who is not FEMALE', async () => {
            const { id } = await kids.create(kid());
            const { id: motherId } = await parent('MALE');

            await expect(kids.update(id, { motherId })).rejects.toMatchObject({
                code: 'MOTHER_NOT_FEMALE',
            });
        });

        test('answers 404 for a missing kid', async () => {
            await expect(
                kids.update('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', {})
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });
    });

    describe('replace', () => {
        test('checks the rules against the new record', async () => {
            const { id } = await kids.create(kid());
            const { id: groupId } = await group(4);

            await expect(
                kids.replace(id, kid({ age: 3, groupId }))
            ).rejects.toMatchObject({ code: 'GROUP_AGE_MISMATCH' });
            expect(
                await kids.replace(id, kid({ age: 4, groupId }))
            ).toMatchObject({ age: 4, groupId });
        });
    });

    describe('delete (FR-018)', () => {
        const note = (kidId) =>
            repositories.notes.create({ text: 'Алергія на горіхи', kidId });

        test('deletes the notes of the kid with them, and only those', async () => {
            // ARRANGE
            const { id } = await kids.create(kid());
            const { id: otherId } = await kids.create(kid());
            await note(id);
            await note(id);
            const other = await note(otherId);

            // ACT
            await kids.delete(id);

            // ASSERT
            expect(await kids.find(id)).toBeNull();
            expect((await repositories.notes.findPage()).items).toEqual([
                other,
            ]);
        });

        test('deletes the group of its last kid; the educator stays, the room loses it', async () => {
            // ARRANGE
            const educator = await repositories.educators.create({
                firstName: 'Ганна',
                lastName: 'Мельник',
            });
            const { id: groupId } = await repositories.groups.create({
                name: 'Сонечко',
                age: 3,
                educatorId: educator.id,
            });
            const room = await repositories.rooms.create({
                name: 'Зал',
                groupId,
            });
            const { id } = await kids.create(kid({ groupId }));

            // ACT
            await kids.delete(id);

            // ASSERT
            expect(await repositories.groups.findById(groupId)).toBeNull();
            expect(await repositories.educators.findById(educator.id)).toEqual(
                educator
            );
            expect(
                (await repositories.rooms.getById(room.id)).groupId
            ).toBeNull();
        });

        test('keeps a group that still has kids', async () => {
            const { id: groupId } = await group();
            const { id } = await kids.create(kid({ groupId }));
            await kids.create(kid({ groupId }));

            await kids.delete(id);

            expect(await repositories.groups.findById(groupId)).not.toBeNull();
        });

        test('deletes the parents left without kids, keeps the others', async () => {
            // ARRANGE: the mother has another kid, the father has not
            const mother = await parent('FEMALE');
            const father = await parent('MALE');
            const { id } = await kids.create(
                kid({ motherId: mother.id, fatherId: father.id })
            );
            await kids.create(kid({ motherId: mother.id }));

            // ACT
            await kids.delete(id);

            // ASSERT
            expect(await repositories.parents.findById(mother.id)).toEqual(
                mother
            );
            expect(await repositories.parents.findById(father.id)).toBeNull();
        });

        test('keeps a parent who has another kid in the other role', async () => {
            // the rules forbid it, but records written past them (through the
            // repository, as here) may have it: both roles count
            const { id: parentId } = await parent('FEMALE');
            const { id } = await kids.create(kid({ motherId: parentId }));
            await repositories.kids.create(kid({ fatherId: parentId }));

            await kids.delete(id);

            expect(
                await repositories.parents.findById(parentId)
            ).not.toBeNull();
        });

        test('deletes a kid without a group or parents, and nothing else', async () => {
            // ARRANGE: the only kid, so no kid is left without a group either
            // (a missing groupId must not be counted as a group), and an
            // empty group that is not theirs
            const { id } = await kids.create(kid());
            const { id: emptyGroupId } = await group();

            // ACT
            const report = await kids.delete(id);

            // ASSERT
            expect(report.deleted).toEqual([{ collection: 'kids', id }]);
            expect(
                await repositories.groups.findById(emptyGroupId)
            ).not.toBeNull();
        });

        test('reports everything it deleted or updated', async () => {
            // ARRANGE
            const { id: motherId } = await parent('FEMALE');
            const { id: groupId } = await group();
            const room = await repositories.rooms.create({
                name: 'Зал',
                groupId,
            });
            const { id } = await kids.create(kid({ motherId, groupId }));
            const { id: noteId } = await note(id);

            // ACT
            const report = await kids.delete(id);

            // ASSERT
            expect(report.deleted).toEqual([
                { collection: 'notes', id: noteId },
                { collection: 'kids', id },
                { collection: 'parents', id: motherId },
                { collection: 'groups', id: groupId },
            ]);
            expect(report.updated).toEqual([
                { collection: 'rooms', id: room.id, fields: ['groupId'] },
            ]);
        });

        test('answers 404 for a missing kid', async () => {
            await expect(
                kids.delete('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')
            ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });
    });
});
