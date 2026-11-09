import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import path from 'node:path';
import { FileDatabase } from '../../src/storage/file-database.js';
import { createContainer } from '../../src/container.js';
import { MAX_ROOMS } from '../../src/services/room-service.js';
import { copySchema } from '../../scripts/copy-schema.js';
import { createTempDir, removeDir } from '../helpers/temp-db.js';

const SCHEMA = path.resolve(import.meta.dirname, '..', '..', 'database');

describe('RoomService', () => {
    let root;
    let db;
    let rooms;
    let repositories;

    beforeEach(async () => {
        root = await createTempDir();
        await copySchema(SCHEMA, root);
        db = await new FileDatabase(root).init();
        const container = createContainer(db);
        repositories = container.repositories;
        rooms = container.services.rooms;
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    let counter = 0;
    const group = () =>
        repositories.groups.create({ name: `Group ${++counter}`, age: 3 });
    const subject = () =>
        repositories.subjects.create({ name: `Subject ${++counter}` });
    /** Adds rooms through the repository, past the rules. */
    const fill = async (count) => {
        for (let i = 0; i < count; i++) {
            await repositories.rooms.create({ name: `Room ${++counter}` });
        }
    };

    describe('create', () => {
        test.each([
            ['a free room', () => ({})],
            [
                'a room for a group',
                async () => ({ groupId: (await group()).id }),
            ],
            [
                'a room for classes',
                async () => ({ subjectIds: [(await subject()).id] }),
            ],
            [
                'a group with an empty list of subjects',
                async () => ({ groupId: (await group()).id, subjectIds: [] }),
            ],
        ])('accepts %s', async (name, makeFields) => {
            const fields = await makeFields();

            const room = await rooms.create({ name: 'Кімната', ...fields });

            expect(room).toMatchObject(fields);
        });

        test('rejects a room for a group and for classes (BR-14)', async () => {
            const data = {
                name: 'Кімната',
                groupId: (await group()).id,
                subjectIds: [(await subject()).id],
            };

            await expect(rooms.create(data)).rejects.toMatchObject({
                status: 422,
                code: 'ROOM_PURPOSE_CONFLICT',
            });
            expect((await repositories.rooms.findPage()).total).toBe(0);
        });

        test(`takes the room up to ${MAX_ROOMS}`, async () => {
            await fill(MAX_ROOMS - 1);

            await rooms.create({ name: 'Остання' });

            expect(await repositories.rooms.count()).toBe(MAX_ROOMS);
        });

        test(`rejects room ${MAX_ROOMS + 1} (BR-13)`, async () => {
            await fill(MAX_ROOMS);

            await expect(rooms.create({ name: 'Зайва' })).rejects.toMatchObject(
                {
                    status: 409,
                    code: 'ROOM_LIMIT_REACHED',
                }
            );
            expect(await repositories.rooms.count()).toBe(MAX_ROOMS);
        });

        test('takes a new room once one is deleted', async () => {
            await fill(MAX_ROOMS);
            const [first] = (await repositories.rooms.findPage()).items;
            await rooms.delete(first.id);

            await expect(rooms.create({ name: 'Нова' })).resolves.toBeTruthy();
        });

        test('two creates at once cannot both take the last place', async () => {
            await fill(MAX_ROOMS - 1);

            const results = await Promise.allSettled([
                rooms.create({ name: 'Перша' }),
                rooms.create({ name: 'Друга' }),
            ]);

            expect(results.map(({ status }) => status).sort()).toEqual([
                'fulfilled',
                'rejected',
            ]);
            expect(results.find(({ reason }) => reason)?.reason.code).toBe(
                'ROOM_LIMIT_REACHED'
            );
            expect(await repositories.rooms.count()).toBe(MAX_ROOMS);
        });
    });

    describe('replace', () => {
        test('rejects a room for a group and for classes (BR-14)', async () => {
            const { id } = await rooms.create({ name: 'Кімната' });

            await expect(
                rooms.replace(id, {
                    name: 'Кімната',
                    groupId: (await group()).id,
                    subjectIds: [(await subject()).id],
                })
            ).rejects.toMatchObject({ code: 'ROOM_PURPOSE_CONFLICT' });
        });

        test('is not limited by BR-13: the number of rooms stays', async () => {
            const { id } = await rooms.create({ name: 'Кімната' });
            await fill(MAX_ROOMS - 1);

            await expect(
                rooms.replace(id, { name: 'Нова назва' })
            ).resolves.toMatchObject({ name: 'Нова назва' });
        });
    });

    describe('update', () => {
        test('rejects a group for a room with subjects (BR-14)', async () => {
            const { id } = await rooms.create({
                name: 'Кімната',
                subjectIds: [(await subject()).id],
            });

            await expect(
                rooms.update(id, { groupId: (await group()).id })
            ).rejects.toMatchObject({ code: 'ROOM_PURPOSE_CONFLICT' });
            expect((await repositories.rooms.getById(id)).groupId).toBeNull();
        });

        test('rejects subjects for a room of a group (BR-14)', async () => {
            const { id } = await rooms.create({
                name: 'Кімната',
                groupId: (await group()).id,
            });

            await expect(
                rooms.update(id, { subjectIds: [(await subject()).id] })
            ).rejects.toMatchObject({ code: 'ROOM_PURPOSE_CONFLICT' });
        });

        test('changes the purpose when both fields change together', async () => {
            const { id } = await rooms.create({
                name: 'Кімната',
                groupId: (await group()).id,
            });
            const music = await subject();

            const room = await rooms.update(id, {
                groupId: null,
                subjectIds: [music.id],
            });

            expect(room).toMatchObject({
                groupId: null,
                subjectIds: [music.id],
            });
        });

        test('accepts a change of the name of a room of a group', async () => {
            const { id } = await rooms.create({
                name: 'Кімната',
                groupId: (await group()).id,
            });

            await expect(
                rooms.update(id, { name: 'Інша' })
            ).resolves.toMatchObject({ name: 'Інша' });
        });

        test('answers 404 for a missing room', async () => {
            await expect(
                rooms.update('01900000-0000-7000-8000-000000000000', {
                    name: 'Інша',
                })
            ).rejects.toMatchObject({ status: 404 });
        });
    });
});
