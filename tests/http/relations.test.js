import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { createReadyGroup } from '../helpers/ready-group.js';
import { createTestApp } from '../helpers/test-app.js';

// TS-02.1: records related to another one, read through its path
describe('related records', () => {
    let app;
    let container;
    let close;
    let repositories;

    beforeEach(async () => {
        ({ app, container, close } = await createTestApp());
        repositories = container.repositories;
    });

    afterEach(async () => close());

    const kid = (fields = {}) =>
        repositories.kids.create({
            firstName: 'Марко',
            lastName: 'Коваль',
            age: 3,
            sex: 'MALE',
            ...fields,
        });
    const parent = (sex) =>
        repositories.parents.create({
            firstName: 'Олена',
            lastName: 'Коваль',
            sex,
        });
    const get = (path, query) =>
        request(app)
            .get(path)
            .query(query ?? {})
            .expect(200);

    describe('GET /api/groups/:id/kids', () => {
        test('answers a page of the kids of the group only', async () => {
            const group = await createReadyGroup(repositories);
            const other = await createReadyGroup(repositories);
            const a = await kid({ groupId: group.id });
            const b = await kid({ groupId: group.id });
            await kid({ groupId: other.id });
            await kid();

            const response = await get(`/api/groups/${group.id}/kids`);

            expect(response.body).toEqual({
                items: [a, b],
                total: 2,
                limit: 100,
                offset: 0,
            });
        });

        test('filters, sorts and pages within the group', async () => {
            // ARRANGE
            const group = await createReadyGroup(repositories);
            await kid({ groupId: group.id, firstName: 'Андрій' });
            const b = await kid({ groupId: group.id, firstName: 'Богдан' });
            await kid({ groupId: group.id, firstName: 'Віра', sex: 'FEMALE' });
            await kid({ firstName: 'Борис' });

            // ACT
            const response = await get(`/api/groups/${group.id}/kids`, {
                where: '{"sex":"MALE"}',
                sort: '-firstName',
                limit: '1',
            });

            // ASSERT
            expect(response.body).toMatchObject({ total: 2, limit: 1 });
            expect(response.body.items).toEqual([b]);
        });

        test('keeps to the group of the path when where names another group', async () => {
            const group = await createReadyGroup(repositories);
            const other = await createReadyGroup(repositories);
            await kid({ groupId: other.id });

            const response = await get(`/api/groups/${group.id}/kids`, {
                where: JSON.stringify({ groupId: other.id }),
            });

            expect(response.body.total).toBe(0);
        });

        test('answers an empty page for a group without kids', async () => {
            const group = await createReadyGroup(repositories);

            const response = await get(`/api/groups/${group.id}/kids`);

            expect(response.body.items).toEqual([]);
        });
    });

    describe('GET /api/parents/:id/kids', () => {
        test('answers the kids of the parent in either role', async () => {
            // ARRANGE: the father of one kid is also the father of another,
            // whose mother is someone else
            const mother = await parent('FEMALE');
            const father = await parent('MALE');
            const both = await kid({
                motherId: mother.id,
                fatherId: father.id,
            });
            const fathers = await kid({ fatherId: father.id });
            await kid({ motherId: mother.id, firstName: 'Віра' });
            await kid();

            // ACT
            const response = await get(`/api/parents/${father.id}/kids`);

            // ASSERT
            expect(response.body).toMatchObject({ total: 2 });
            expect(response.body.items).toEqual([both, fathers]);
        });

        test('filters, sorts and pages within the kids of the parent', async () => {
            const mother = await parent('FEMALE');
            await kid({ motherId: mother.id, age: 2 });
            const four = await kid({ motherId: mother.id, age: 4 });
            const five = await kid({ motherId: mother.id, age: 5 });
            await kid({ age: 5 });

            const response = await get(`/api/parents/${mother.id}/kids`, {
                where: '{"age":{"gte":4}}',
                sort: '-age',
            });

            expect(response.body.items).toEqual([five, four]);
        });

        test('keeps to the kids of the parent when where names other ids', async () => {
            const mother = await parent('FEMALE');
            const own = await kid({ motherId: mother.id });
            const stranger = await kid();

            const response = await get(`/api/parents/${mother.id}/kids`, {
                where: JSON.stringify({ id: { in: [stranger.id] } }),
            });

            expect(response.body.items).toEqual([own]);
        });

        test('answers an empty page for a parent without kids', async () => {
            const mother = await parent('FEMALE');

            const response = await get(`/api/parents/${mother.id}/kids`);

            expect(response.body).toMatchObject({ items: [], total: 0 });
        });
    });

    describe('GET /api/groups/:id/room', () => {
        test('answers the room of the group', async () => {
            const group = await createReadyGroup(repositories);
            const room = await repositories.rooms.findByGroup(group.id);

            const response = await get(`/api/groups/${group.id}/room`);

            expect(response.body).toEqual(room);
        });

        test('answers null for a group without a room', async () => {
            const group = await repositories.groups.create({
                name: 'Сонечко',
                age: 3,
            });

            const response = await get(`/api/groups/${group.id}/room`);

            expect(response.body).toBeNull();
        });
    });

    describe.each([
        ['educators', 'educatorId'],
        ['assistants', 'assistantId'],
    ])('GET /api/%s/:id/group', (collection, field) => {
        const createWorker = () =>
            repositories[collection].create({
                firstName: 'Ганна',
                lastName: 'Мельник',
            });

        test('answers the group of the worker', async () => {
            const worker = await createWorker();
            const group = await repositories.groups.create({
                name: 'Сонечко',
                age: 3,
                [field]: worker.id,
            });

            const response = await get(`/api/${collection}/${worker.id}/group`);

            expect(response.body).toEqual({
                ...group,
                attendsSpeechLessons: false,
            });
        });

        test('answers null for a worker without a group', async () => {
            const worker = await createWorker();

            const response = await get(`/api/${collection}/${worker.id}/group`);

            expect(response.body).toBeNull();
        });
    });

    describe('GET /api/subjects/:id/teachers and /rooms', () => {
        let music;
        let drawing;

        beforeEach(async () => {
            music = await repositories.subjects.create({ name: 'Музика' });
            drawing = await repositories.subjects.create({ name: 'Малювання' });
        });

        test('answers the teachers of the subject', async () => {
            const teacher = (lastName, subjectIds) =>
                repositories.teachers.create({
                    firstName: 'Олена',
                    lastName,
                    subjectIds,
                });
            const both = await teacher('Бойко', [drawing.id, music.id]);
            const musician = await teacher('Андрієнко', [music.id]);
            await teacher('Гнатюк', [drawing.id]);

            const response = await get(`/api/subjects/${music.id}/teachers`, {
                sort: 'lastName',
            });

            expect(response.body.items).toEqual([musician, both]);
        });

        test('answers the rooms of the subject', async () => {
            const hall = await repositories.rooms.create({
                name: 'Зал',
                subjectIds: [music.id],
            });
            await repositories.rooms.create({
                name: 'Студія',
                subjectIds: [drawing.id],
            });

            const response = await get(`/api/subjects/${music.id}/rooms`);

            expect(response.body.items).toEqual([hall]);
        });

        test('answers an empty page for a subject nobody teaches', async () => {
            const response = await get(`/api/subjects/${music.id}/teachers`);

            expect(response.body.items).toEqual([]);
        });
    });

    describe('GET /api/discounts/:id/kids', () => {
        test('answers the kids with the discount', async () => {
            const discount = await repositories.discounts.create({
                name: 'Пільга',
                rate: 0.1,
            });
            const other = await repositories.discounts.create({
                name: 'Інша',
                rate: 0.2,
            });
            const withIt = await kid({ discountId: discount.id });
            await kid({ discountId: other.id });
            await kid();

            const response = await get(`/api/discounts/${discount.id}/kids`);

            expect(response.body.items).toEqual([withIt]);
        });
    });

    describe('every related path', () => {
        const PATHS = [
            ['groups', 'kids', 'listKids'],
            ['groups', 'room', 'getRoom'],
            ['parents', 'kids', 'listKids'],
            ['educators', 'group', 'getGroup'],
            ['assistants', 'group', 'getGroup'],
            ['subjects', 'teachers', 'listTeachers'],
            ['subjects', 'rooms', 'listRooms'],
            ['discounts', 'kids', 'listKids'],
        ];

        test.each(PATHS)(
            '/api/%s/:id/%s answers 404 for a missing record',
            async (collection, relation) => {
                const response = await request(app)
                    .get(`/api/${collection}/${uuidv7()}/${relation}`)
                    .expect(404);

                expect(response.body.error.code).toBe('NOT_FOUND');
            }
        );

        test.each(PATHS)(
            '/api/%s/:id/%s stops a malformed id before the service',
            async (collection, relation, method) => {
                const spy = vi.spyOn(container.services[collection], method);

                for (const id of ['abc', uuidv4()]) {
                    const response = await request(app)
                        .get(`/api/${collection}/${id}/${relation}`)
                        .expect(400);
                    expect(response.body.error.code).toBe('INVALID_ID');
                }
                expect(spy).not.toHaveBeenCalled();
            }
        );

        test.each(PATHS.filter(([, relation]) => relation.endsWith('s')))(
            '/api/%s/:id/%s rejects an invalid query',
            async (collection, relation) => {
                const response = await request(app)
                    .get(`/api/${collection}/${uuidv7()}/${relation}`)
                    .query({ limt: '5' })
                    .expect(400);

                expect(response.body.error.code).toBe('INVALID_QUERY');
            }
        );
    });
});
