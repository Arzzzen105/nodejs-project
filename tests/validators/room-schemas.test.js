import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRoom, updateRoom } from '../../src/validators/room-schemas.js';
import { createTestApp } from '../helpers/test-app.js';

const CONFIG = path.resolve(
    import.meta.dirname,
    '../../database/rooms/config.json'
);

const VALID = { name: 'Кімната 1' };

describe('room schemas', () => {
    test('createRoom has exactly the columns of the collection', async () => {
        const { columns } = JSON.parse(await fs.readFile(CONFIG, 'utf8'));

        expect(Object.keys(createRoom.shape).sort()).toEqual(
            Object.keys(columns).sort()
        );
    });

    test('updateRoom accepts any part of the fields and adds nothing', () => {
        expect(updateRoom.parse({})).toEqual({});
        expect(updateRoom.parse({ groupId: null })).toEqual({ groupId: null });
    });

    test.each([['id'], ['unknown']])(
        'rejects "%s", which the client cannot set',
        (field) => {
            const body = { ...VALID, [field]: 'x' };

            expect(createRoom.safeParse(body).success).toBe(false);
            expect(updateRoom.safeParse({ [field]: 'x' }).success).toBe(false);
        }
    );

    describe('agrees with the database', () => {
        let repositories;
        let close;
        let gym;
        let wrestling;
        let group;

        beforeEach(async () => {
            const testApp = await createTestApp();
            repositories = testApp.container.repositories;
            close = testApp.close;
            gym = await repositories.subjects.create({ name: 'Фізкультура' });
            wrestling = await repositories.subjects.create({
                name: 'Боротьба',
            });
            group = await repositories.groups.create({
                name: 'Сонечко',
                age: 3,
            });
        });

        afterEach(async () => close());

        /** Whether the database stores the record, past the service rules. */
        const databaseAccepts = (body) =>
            repositories.rooms.create(body).then(
                () => true,
                () => false
            );

        // the subjects and the group exist only once the database is created
        test.each([
            ['valid room', () => VALID],
            ['no name', () => ({})],
            ['empty name', () => ({ name: '' })],
            ['name of 25', () => ({ name: 'x'.repeat(25) })],
            ['name of 26', () => ({ name: 'x'.repeat(26) })],
            ['name not a string', () => ({ name: 1 })],
            ['a group', () => ({ ...VALID, groupId: group.id })],
            ['groupId null', () => ({ ...VALID, groupId: null })],
            ['groupId not a string', () => ({ ...VALID, groupId: 1 })],
            ['groupId not a UUID', () => ({ ...VALID, groupId: 'abc' })],
            ['no subjects', () => ({ ...VALID, subjectIds: [] })],
            [
                'a gym with two subjects',
                () => ({ ...VALID, subjectIds: [gym.id, wrestling.id] }),
            ],
            [
                'the same subject twice',
                () => ({ ...VALID, subjectIds: [gym.id, gym.id] }),
            ],
            ['subjectIds null', () => ({ ...VALID, subjectIds: null })],
            ['subject not a UUID', () => ({ ...VALID, subjectIds: ['abc'] })],
        ])('%s', async (name, makeBody) => {
            const body = makeBody();

            expect(createRoom.safeParse(body).success).toBe(
                await databaseAccepts(body)
            );
        });
    });
});
