import { describe, beforeAll, afterAll, test, expect } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';
import { createReadyGroup } from '../helpers/ready-group.js';

/**
 * Which records each role sees (TS-03.3, NFR-04).
 *
 * Group A: kid1 (mom1 and dad1, with a discount) and kid3 (mom2).
 * Group B: kid2 (mom1 again) and kid4 (mom3).
 * The educator of group A, mom1 and a teacher have accounts.
 */
describe('own records (TS-03.3)', () => {
    let testApp;
    let data;
    let as;

    const ids = (body) => body.items.map((record) => record.id).sort();
    const sorted = (...records) => records.map((record) => record.id).sort();

    beforeAll(async () => {
        testApp = await createTestApp();
        const { repositories } = testApp.container;

        const groupA = await createReadyGroup(repositories);
        const groupB = await createReadyGroup(repositories);
        const parent = (firstName, sex = 'FEMALE') =>
            repositories.parents.create({ firstName, lastName: 'Koval', sex });
        const mom1 = await parent('Olena');
        const dad1 = await parent('Ivan', 'MALE');
        const mom2 = await parent('Iryna');
        const mom3 = await parent('Oksana');
        const discount = await repositories.discounts.create({
            name: 'Large family',
            rate: 0.2,
        });
        const otherDiscount = await repositories.discounts.create({
            name: 'Veteran',
            rate: 0.3,
        });
        const kid = (firstName, fields) =>
            repositories.kids.create({
                firstName,
                lastName: 'Koval',
                age: 3,
                sex: 'MALE',
                ...fields,
            });
        const kid1 = await kid('Marko', {
            groupId: groupA.id,
            motherId: mom1.id,
            fatherId: dad1.id,
            discountId: discount.id,
            needsSpeechLessons: true,
        });
        const kid3 = await kid('Taras', {
            groupId: groupA.id,
            motherId: mom2.id,
        });
        const kid2 = await kid('Petro', {
            groupId: groupB.id,
            motherId: mom1.id,
        });
        const kid4 = await kid('Denys', {
            groupId: groupB.id,
            motherId: mom3.id,
        });
        const noteOfKid1 = await repositories.notes.create({
            text: 'Allergic to nuts',
            kidId: kid1.id,
        });
        const noteOfKid3 = await repositories.notes.create({
            text: 'Likes drawing',
            kidId: kid3.id,
        });
        const teacher = await repositories.teachers.create({
            firstName: 'Petro',
            lastName: 'Shevchuk',
        });
        const otherTeacher = await repositories.teachers.create({
            firstName: 'Anna',
            lastName: 'Lys',
        });

        data = {
            groupA,
            groupB,
            mom1,
            dad1,
            mom2,
            mom3,
            kid1,
            kid2,
            kid3,
            kid4,
            discount,
            otherDiscount,
            noteOfKid1,
            noteOfKid3,
            teacher,
            otherTeacher,
        };

        const tokens = {
            educator: await testApp.signIn({
                role: 'EDUCATOR',
                educatorId: groupA.educatorId,
            }),
            parent: await testApp.signIn({ role: 'PARENT', parentId: mom1.id }),
            teacher: await testApp.signIn({
                role: 'TEACHER',
                teacherId: teacher.id,
            }),
            manager: await testApp.signIn({ role: 'MANAGER' }),
        };
        /** A request of one of the accounts above. */
        as = (who) => {
            const client = request(testApp.rawApp);
            const auth = tokens[who].auth;
            return {
                get: (path) => client.get(path).set(auth),
                post: (path) => client.post(path).set(auth),
                patch: (path) => client.patch(path).set(auth),
                put: (path) => client.put(path).set(auth),
                delete: (path) => client.delete(path).set(auth),
            };
        };
    });

    afterAll(async () => testApp.close());

    describe('the manager', () => {
        test('sees every kid', async () => {
            const { body } = await as('manager').get('/api/kids').expect(200);

            expect(body.total).toBe(4);
        });
    });

    describe('an educator', () => {
        test('lists the kids of their group only', async () => {
            const { body } = await as('educator').get('/api/kids').expect(200);

            expect(ids(body)).toEqual(sorted(data.kid1, data.kid3));
        });

        test('cannot widen the list with a filter of their own', async () => {
            const { body } = await as('educator')
                .get('/api/kids')
                .query({ where: JSON.stringify({ groupId: data.groupB.id }) })
                .expect(200);

            expect(ids(body)).toEqual(sorted(data.kid1, data.kid3));
        });

        test('reads a kid of their group', async () => {
            const { body } = await as('educator')
                .get(`/api/kids/${data.kid1.id}`)
                .expect(200);

            expect(body).toEqual(data.kid1);
        });

        test('answers 403 for a kid of another group', async () => {
            const response = await as('educator')
                .get(`/api/kids/${data.kid4.id}`)
                .expect(403);

            expect(response.body.error.code).toBe('FORBIDDEN');
        });

        test('answers 404 for a kid that does not exist', async () => {
            await as('educator')
                .get('/api/kids/0190a000-0000-7000-8000-000000000000')
                .expect(404);
        });

        test('lists the parents of the kids of their group', async () => {
            const { body } = await as('educator')
                .get('/api/parents')
                .expect(200);

            expect(ids(body)).toEqual(sorted(data.mom1, data.dad1, data.mom2));
        });

        test('reads a parent of their group, but not another one', async () => {
            await as('educator')
                .get(`/api/parents/${data.mom2.id}`)
                .expect(200);
            await as('educator')
                .get(`/api/parents/${data.mom3.id}`)
                .expect(403);
        });

        test('sees only the kids of their group of a parent', async () => {
            // mom1 has kid2 in group B as well
            const { body } = await as('educator')
                .get(`/api/parents/${data.mom1.id}/kids`)
                .expect(200);

            expect(ids(body)).toEqual(sorted(data.kid1));
        });

        test('lists and reads their group only', async () => {
            const { body } = await as('educator')
                .get('/api/groups')
                .expect(200);

            expect(ids(body)).toEqual(sorted(data.groupA));
            await as('educator')
                .get(`/api/groups/${data.groupA.id}`)
                .expect(200);
            await as('educator')
                .get(`/api/groups/${data.groupB.id}`)
                .expect(403);
        });

        test('sees the kids of their group in full', async () => {
            const { body } = await as('educator')
                .get(`/api/groups/${data.groupA.id}/kids`)
                .expect(200);

            expect(body.items).toContainEqual(data.kid1);
        });

        test('does not see the kids of another group', async () => {
            await as('educator')
                .get(`/api/groups/${data.groupB.id}/kids`)
                .expect(403);
        });

        test('sees the room of their group only', async () => {
            await as('educator')
                .get(`/api/groups/${data.groupA.id}/room`)
                .expect(200);
            await as('educator')
                .get(`/api/groups/${data.groupB.id}/room`)
                .expect(403);
        });

        test('reads their own profile and group, not another educator', async () => {
            const own = data.groupA.educatorId;
            const other = data.groupB.educatorId;

            await as('educator').get(`/api/educators/${own}`).expect(200);
            const { body } = await as('educator')
                .get(`/api/educators/${own}/group`)
                .expect(200);
            expect(body.id).toBe(data.groupA.id);
            await as('educator').get(`/api/educators/${other}`).expect(403);
            await as('educator')
                .get(`/api/educators/${other}/group`)
                .expect(403);
        });

        test('reads the notes of their group, not of another', async () => {
            const { body } = await as('educator')
                .get(`/api/kids/${data.kid1.id}/notes`)
                .expect(200);
            expect(ids(body)).toEqual(sorted(data.noteOfKid1));
            await as('educator')
                .get(`/api/kids/${data.kid1.id}/notes/${data.noteOfKid1.id}`)
                .expect(200);
            await as('educator')
                .get(`/api/kids/${data.kid4.id}/notes`)
                .expect(403);
        });

        test('does not write notes', async () => {
            await as('educator')
                .post(`/api/kids/${data.kid1.id}/notes`)
                .send({ text: 'Slept well' })
                .expect(403);
        });

        test('without a group sees no kids', async () => {
            const educator =
                await testApp.container.repositories.educators.create({
                    firstName: 'New',
                    lastName: 'Educator',
                });
            const { auth } = await testApp.signIn({
                role: 'EDUCATOR',
                educatorId: educator.id,
            });

            const { body } = await request(testApp.rawApp)
                .get('/api/kids')
                .set(auth)
                .expect(200);

            expect(body.total).toBe(0);
        });
    });

    describe('a parent', () => {
        test('lists their own kids, in any group', async () => {
            const { body } = await as('parent').get('/api/kids').expect(200);

            expect(ids(body)).toEqual(sorted(data.kid1, data.kid2));
        });

        test('reads their kid, not another one', async () => {
            await as('parent').get(`/api/kids/${data.kid1.id}`).expect(200);
            await as('parent').get(`/api/kids/${data.kid3.id}`).expect(403);
        });

        test('sees only themselves among the parents', async () => {
            const { body } = await as('parent').get('/api/parents').expect(200);

            expect(ids(body)).toEqual(sorted(data.mom1));
            await as('parent').get(`/api/parents/${data.mom1.id}`).expect(200);
            await as('parent').get(`/api/parents/${data.mom2.id}`).expect(403);
        });

        test('lists their kids through their own record', async () => {
            const { body } = await as('parent')
                .get(`/api/parents/${data.mom1.id}/kids`)
                .expect(200);

            expect(ids(body)).toEqual(sorted(data.kid1, data.kid2));
            await as('parent')
                .get(`/api/parents/${data.mom3.id}/kids`)
                .expect(403);
        });

        test('sees the groups of their kids', async () => {
            const { body } = await as('parent').get('/api/groups').expect(200);

            expect(ids(body)).toEqual(sorted(data.groupA, data.groupB));
        });

        test('sees only the names of the kids of a group', async () => {
            const { body } = await as('parent')
                .get(`/api/groups/${data.groupA.id}/kids`)
                .query({ sort: 'firstName' })
                .expect(200);

            expect(body.items).toEqual([
                {
                    id: data.kid1.id,
                    firstName: 'Marko',
                    lastName: 'Koval',
                },
                {
                    id: data.kid3.id,
                    firstName: 'Taras',
                    lastName: 'Koval',
                },
            ]);
        });

        test('filters the kids of a group by name', async () => {
            const { body } = await as('parent')
                .get(`/api/groups/${data.groupA.id}/kids`)
                .query({ where: '{"firstName":"Taras"}', sort: '-lastName' })
                .expect(200);

            expect(ids(body)).toEqual(sorted(data.kid3));
        });

        test.each([
            ['filter', { where: '{"needsSpeechLessons":true}' }],
            ['sort', { sort: 'lastName,-age' }],
        ])(
            'cannot %s the kids of a group by a hidden field',
            async (name, query) => {
                const response = await as('parent')
                    .get(`/api/groups/${data.groupA.id}/kids`)
                    .query(query)
                    .expect(403);

                expect(response.body.error.code).toBe('FORBIDDEN');
            }
        );

        test('does not see a group without their kids', async () => {
            const { auth } = await testApp.signIn({
                role: 'PARENT',
                parentId: data.mom3.id,
            });

            await request(testApp.rawApp)
                .get(`/api/groups/${data.groupA.id}`)
                .set(auth)
                .expect(403);
            await request(testApp.rawApp)
                .get(`/api/groups/${data.groupA.id}/kids`)
                .set(auth)
                .expect(403);
        });

        test('reads the discount of their kid, not another one', async () => {
            await as('parent')
                .get(`/api/discounts/${data.discount.id}`)
                .expect(200);
            await as('parent')
                .get(`/api/discounts/${data.otherDiscount.id}`)
                .expect(403);
        });

        test('writes notes about their own kid', async () => {
            // ACT
            const created = await as('parent')
                .post(`/api/kids/${data.kid1.id}/notes`)
                .send({ text: 'Picked up early on Friday' })
                .expect(201);
            const path = `/api/kids/${data.kid1.id}/notes/${created.body.id}`;

            // ASSERT
            await as('parent').get(path).expect(200);
            await as('parent')
                .patch(path)
                .send({ text: 'Picked up at 3 pm on Friday' })
                .expect(200);
            await as('parent')
                .put(path)
                .send({ text: 'Picked up at 4 pm on Friday' })
                .expect(200);
            await as('parent').delete(path).expect(204);
        });

        test('does not touch the notes of another kid', async () => {
            // ARRANGE
            const path = `/api/kids/${data.kid3.id}/notes`;
            const note = `${path}/${data.noteOfKid3.id}`;

            // ACT + ASSERT
            await as('parent').get(path).expect(403);
            await as('parent').post(path).send({ text: 'x' }).expect(403);
            await as('parent').get(note).expect(403);
            await as('parent').patch(note).send({ text: 'x' }).expect(403);
            await as('parent').put(note).send({ text: 'x' }).expect(403);
            await as('parent').delete(note).expect(403);

            const stored = await testApp.container.repositories.notes.getById(
                data.noteOfKid3.id
            );
            expect(stored.text).toBe('Likes drawing');
            const { total } =
                await testApp.container.repositories.notes.findPage({
                    where: { kidId: data.kid3.id },
                });
            expect(total).toBe(1);
        });

        test('does not change kids', async () => {
            await as('parent')
                .patch(`/api/kids/${data.kid1.id}`)
                .send({ firstName: 'Maks' })
                .expect(403);
        });
    });

    describe('a teacher', () => {
        test('reads their own profile, not another teacher', async () => {
            await as('teacher')
                .get(`/api/teachers/${data.teacher.id}`)
                .expect(200);
            await as('teacher')
                .get(`/api/teachers/${data.otherTeacher.id}`)
                .expect(403);
        });

        test('does not list teachers', async () => {
            await as('teacher').get('/api/teachers').expect(403);
        });
    });
});
