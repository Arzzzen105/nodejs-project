import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import path from 'node:path';
import { FileDatabase } from '../../src/storage/file-database.js';
import { createContainer } from '../../src/container.js';
import { PROBLEMS } from '../../src/services/consistency-service.js';
import { copySchema } from '../../scripts/copy-schema.js';
import { createReadyGroup } from '../helpers/ready-group.js';
import { createTempDir, removeDir } from '../helpers/temp-db.js';

const SCHEMA = path.resolve(import.meta.dirname, '..', '..', 'database');

describe('ConsistencyService (FR-019)', () => {
    let root;
    let db;
    let consistency;
    let repositories;

    beforeEach(async () => {
        root = await createTempDir();
        await copySchema(SCHEMA, root);
        db = await new FileDatabase(root).init();
        const container = createContainer(db);
        repositories = container.repositories;
        consistency = container.services.consistency;
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    const parent = (sex) =>
        repositories.parents.create({
            firstName: 'Олена',
            lastName: 'Коваль',
            sex,
        });
    /** A kid with nothing wrong unless the fields say otherwise. */
    const kid = async (fields = {}) =>
        repositories.kids.create({
            firstName: 'Марко',
            lastName: 'Коваль',
            age: 3,
            sex: 'MALE',
            motherId: (await parent('FEMALE')).id,
            fatherId: (await parent('MALE')).id,
            ...fields,
        });
    const problemsOf = async (entity, id) =>
        (await consistency.list(entity)).items.find((item) => item.id === id)
            ?.problems ?? [];

    test('finds nothing when everything is in order', async () => {
        const group = await createReadyGroup(repositories);
        await kid({ groupId: group.id });

        expect(await consistency.summary()).toEqual({ problems: [] });
        for (const entity of Object.keys(PROBLEMS)) {
            expect(await consistency.list(entity), entity).toEqual({
                items: [],
                total: 0,
                limit: 100,
                offset: 0,
            });
        }
    });

    describe('kids', () => {
        test('KID_WITHOUT_GROUP', async () => {
            const { id } = await kid();

            expect(await problemsOf('kids', id)).toEqual(['KID_WITHOUT_GROUP']);
        });

        test.each([
            ['no mother', { motherId: null }],
            ['no father', { fatherId: null }],
            ['no parents', { motherId: null, fatherId: null }],
        ])('KID_INCOMPLETE_PARENTS with %s (BR-11)', async (name, fields) => {
            const group = await createReadyGroup(repositories);
            const { id } = await kid({ groupId: group.id, ...fields });

            expect(await problemsOf('kids', id)).toEqual([
                'KID_INCOMPLETE_PARENTS',
            ]);
        });

        test('KID_GROUP_AGE_MISMATCH after the age of the group changed (BR-02)', async () => {
            const group = await createReadyGroup(repositories);
            const { id } = await kid({ groupId: group.id });
            await repositories.groups.update(group.id, { age: 4 });

            expect(await problemsOf('kids', id)).toEqual([
                'KID_GROUP_AGE_MISMATCH',
            ]);
        });

        test('a kid with several problems is listed once, with all of them', async () => {
            await kid();
            const { id } = await kid({ motherId: null });

            const page = await consistency.list('kids');

            expect(page.items.filter((item) => item.id === id)).toHaveLength(1);
            expect(await problemsOf('kids', id)).toEqual([
                'KID_WITHOUT_GROUP',
                'KID_INCOMPLETE_PARENTS',
            ]);
        });

        test('the record comes as stored, with its problems on top', async () => {
            const stored = await kid();

            const [item] = (await consistency.list('kids')).items;

            expect(item).toEqual({
                ...stored,
                problems: ['KID_WITHOUT_GROUP'],
            });
        });
    });

    describe('groups', () => {
        test.each([
            ['GROUP_WITHOUT_EDUCATOR', { educatorId: null }],
            ['GROUP_WITHOUT_ASSISTANT', { assistantId: null }],
        ])('%s', async (code, fields) => {
            const group = await createReadyGroup(repositories);
            await repositories.groups.update(group.id, fields);

            expect(await problemsOf('groups', group.id)).toEqual([code]);
        });

        test('GROUP_WITHOUT_ROOM', async () => {
            const group = await createReadyGroup(repositories);
            const room = await repositories.rooms.findByGroup(group.id);
            await repositories.rooms.delete(room.id);

            expect(await problemsOf('groups', group.id)).toEqual([
                'GROUP_WITHOUT_ROOM',
            ]);
        });

        test('GROUP_NOT_READY_WITH_KIDS when a group with kids loses its educator (BR-08)', async () => {
            const group = await createReadyGroup(repositories);
            await kid({ groupId: group.id });
            await repositories.educators.delete(group.educatorId);

            expect(await problemsOf('groups', group.id)).toEqual([
                'GROUP_WITHOUT_EDUCATOR',
                'GROUP_NOT_READY_WITH_KIDS',
            ]);
        });

        test('a bare group without kids is not GROUP_NOT_READY_WITH_KIDS', async () => {
            const group = await repositories.groups.create({
                name: 'Порожня',
                age: 3,
            });

            expect(await problemsOf('groups', group.id)).toEqual([
                'GROUP_WITHOUT_EDUCATOR',
                'GROUP_WITHOUT_ASSISTANT',
                'GROUP_WITHOUT_ROOM',
            ]);
        });
    });

    describe.each([
        ['educators', 'educatorId', 'EDUCATOR_WITHOUT_GROUP'],
        ['assistants', 'assistantId', 'ASSISTANT_WITHOUT_GROUP'],
    ])('%s', (entity, field, code) => {
        test(`${code} for a worker of no group`, async () => {
            const free = await repositories[entity].create({
                firstName: 'Ганна',
                lastName: 'Мельник',
            });
            const group = await createReadyGroup(repositories);

            expect(await problemsOf(entity, free.id)).toEqual([code]);
            expect(await problemsOf(entity, group[field])).toEqual([]);
        });
    });

    describe('summary', () => {
        test('counts each problem and links to its records', async () => {
            // ARRANGE: two kids without a group, one of them also without
            // parents, and an educator of no group
            await kid();
            await kid({ motherId: null, fatherId: null });
            await repositories.educators.create({
                firstName: 'Ганна',
                lastName: 'Мельник',
            });

            // ACT
            const { problems } = await consistency.summary();

            // ASSERT
            expect(problems).toEqual([
                {
                    code: 'KID_WITHOUT_GROUP',
                    entity: 'kids',
                    count: 2,
                    href: '/api/consistency/kids?problem=KID_WITHOUT_GROUP',
                },
                {
                    code: 'KID_INCOMPLETE_PARENTS',
                    entity: 'kids',
                    count: 1,
                    href: '/api/consistency/kids?problem=KID_INCOMPLETE_PARENTS',
                },
                {
                    code: 'EDUCATOR_WITHOUT_GROUP',
                    entity: 'educators',
                    count: 1,
                    href: '/api/consistency/educators?problem=EDUCATOR_WITHOUT_GROUP',
                },
            ]);
        });
    });

    describe('list', () => {
        test('keeps the records with the problem only, with all their problems', async () => {
            const group = await createReadyGroup(repositories);
            await kid({ groupId: group.id, motherId: null });
            const both = await kid({ motherId: null });
            await kid();

            const page = await consistency.list('kids', {
                problem: 'KID_WITHOUT_GROUP',
            });

            expect(page.total).toBe(2);
            expect(
                page.items.find((item) => item.id === both.id).problems
            ).toEqual(['KID_WITHOUT_GROUP', 'KID_INCOMPLETE_PARENTS']);
        });

        test('pages in the order of creation', async () => {
            const kids = [];
            for (let i = 0; i < 5; i++) kids.push(await kid());

            const page = await consistency.list('kids', {
                limit: 2,
                offset: 1,
            });

            expect(page).toMatchObject({ total: 5, limit: 2, offset: 1 });
            expect(page.items.map(({ id }) => id)).toEqual([
                kids[1].id,
                kids[2].id,
            ]);
        });
    });

    test('changes nothing', async () => {
        await kid();
        const before = await repositories.kids.findEvery();

        await consistency.summary();
        await consistency.list('kids');

        expect(await repositories.kids.findEvery()).toEqual(before);
    });
});
