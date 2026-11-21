import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { createTestApp } from '../helpers/test-app.js';
import { seedKindergarten } from '../helpers/kindergarten.js';

describe('the published timetable (TS-05.4, TS-05.5)', () => {
    let app;
    let rawApp;
    let signIn;
    let repositories;
    let close;
    let kindergarten;

    beforeEach(async () => {
        let container;
        ({ app, rawApp, signIn, container, close } = await createTestApp());
        repositories = container.repositories;
        kindergarten = await seedKindergarten(repositories);
    });

    afterEach(async () => close());

    const publish = async () => {
        const { body } = await request(app).post('/api/schedules').expect(201);
        await request(app)
            .post(`/api/schedules/${body.id}/publish`)
            .expect(200);
        return body;
    };
    const as = (auth) => ({
        get: (path) => request(rawApp).get(path).set(auth),
    });
    const events = (body) => Object.values(body.days).flat();

    describe('GET /api/groups/:id/schedule', () => {
        test('the week of the group by day, with times and names', async () => {
            // ARRANGE
            const group = kindergarten.groups[0];
            const draft = await publish();

            // ACT
            const { body } = await request(app)
                .get(`/api/groups/${group.id}/schedule`)
                .expect(200);

            // ASSERT
            expect(body.scheduleId).toBe(draft.id);
            expect(Date.parse(body.publishedAt)).not.toBeNaN();
            expect(Object.keys(body.days)).toEqual([
                'MON',
                'TUE',
                'WED',
                'THU',
                'FRI',
            ]);
            expect(body.days.MON[0]).toMatchObject({
                start: '09:00',
                end: '09:30',
                kind: 'MEAL',
                meal: 'BREAKFAST',
                group: { id: group.id, name: group.name },
                subject: null,
            });
            const lesson = events(body).find((e) => e.kind === 'LESSON');
            expect(lesson.subject.name).toEqual(expect.any(String));
            expect(lesson.teacher).toMatchObject({ firstName: 'Teacher' });
            expect(lesson.room.name).toEqual(expect.any(String));
        });

        test('only events of the group, in order of time each day', async () => {
            const group = kindergarten.groups[1];
            await publish();

            const { body } = await request(app)
                .get(`/api/groups/${group.id}/schedule`)
                .expect(200);

            // 4 meals and sleeps a day, 10 lessons a week; no speech lessons
            expect(events(body)).toHaveLength(30);
            expect(events(body).every((e) => e.group.id === group.id)).toBe(
                true
            );
            for (const day of Object.values(body.days)) {
                const starts = day.map((e) => e.start);
                expect(starts).toEqual([...starts].sort());
            }
        });

        test('an empty week before anything is published', async () => {
            await request(app).post('/api/schedules').expect(201);

            const { body } = await request(app)
                .get(`/api/groups/${kindergarten.groups[0].id}/schedule`)
                .expect(200);

            expect(body).toEqual({
                scheduleId: null,
                publishedAt: null,
                days: { MON: [], TUE: [], WED: [], THU: [], FRI: [] },
            });
        });

        test('answers 404 for a missing group', async () => {
            await request(app)
                .get(`/api/groups/${uuidv7()}/schedule`)
                .expect(404);
        });

        test('the educator sees their group, not another (2.3)', async () => {
            await publish();
            const [own, other] = kindergarten.groups;
            const { auth } = await signIn({
                role: 'EDUCATOR',
                educatorId: own.educatorId,
            });

            await as(auth).get(`/api/groups/${own.id}/schedule`).expect(200);
            await as(auth).get(`/api/groups/${other.id}/schedule`).expect(403);
        });

        test('the parents see the group of their kid, not another (2.6)', async () => {
            await publish();
            const [own, other] = kindergarten.groups;
            const mom = await repositories.parents.create({
                firstName: 'Olena',
                lastName: 'Koval',
                sex: 'FEMALE',
            });
            await repositories.kids.create({
                firstName: 'Taras',
                lastName: 'Koval',
                age: own.age,
                sex: 'MALE',
                groupId: own.id,
                motherId: mom.id,
            });
            const { auth } = await signIn({ role: 'PARENT', parentId: mom.id });

            await as(auth).get(`/api/groups/${own.id}/schedule`).expect(200);
            await as(auth).get(`/api/groups/${other.id}/schedule`).expect(403);
        });
    });

    describe('GET /api/teachers/:id/schedule', () => {
        test('every lesson of the teacher, across groups', async () => {
            await publish();
            const music = kindergarten.teachers.music;

            const { body } = await request(app)
                .get(`/api/teachers/${music.id}/schedule`)
                .expect(200);

            // 4 groups × 2 lessons of music
            expect(events(body)).toHaveLength(8);
            expect(events(body).every((e) => e.teacher.id === music.id)).toBe(
                true
            );
            expect(new Set(events(body).map((e) => e.group.id)).size).toBe(4);
        });

        test('the teacher sees their own, not another teacher (2.4)', async () => {
            await publish();
            const { music, chess } = kindergarten.teachers;
            const { auth } = await signIn({
                role: 'TEACHER',
                teacherId: music.id,
            });

            await as(auth)
                .get(`/api/teachers/${music.id}/schedule`)
                .expect(200);
            await as(auth)
                .get(`/api/teachers/${chess.id}/schedule`)
                .expect(403);
        });
    });

    describe('GET /api/rooms/:id/schedule (FR-009)', () => {
        test('when the gym is taken, by physical education and wrestling', async () => {
            await publish();
            const { gym } = kindergarten.rooms;

            const { body } = await request(app)
                .get(`/api/rooms/${gym.id}/schedule`)
                .expect(200);

            // 4 groups × (2 + 2)
            expect(events(body)).toHaveLength(16);
            expect(new Set(events(body).map((e) => e.subject.name))).toEqual(
                new Set(['Physical education', 'Wrestling'])
            );
        });

        test('a room of a group hosts no lessons', async () => {
            await publish();
            const room = await repositories.rooms.findByGroup(
                kindergarten.groups[0].id
            );

            const { body } = await request(app)
                .get(`/api/rooms/${room.id}/schedule`)
                .expect(200);

            expect(events(body)).toEqual([]);
        });
    });

    describe('the groups of a teacher (2.4, TS-05.5)', () => {
        let speech;

        beforeEach(async () => {
            // the speech therapist teaches only the first group (FR-021)
            speech = await signIn({
                role: 'TEACHER',
                teacherId: kindergarten.teachers.speech.id,
            });
            await repositories.kids.create({
                firstName: 'Olia',
                lastName: 'Lys',
                age: kindergarten.groups[0].age,
                sex: 'FEMALE',
                groupId: kindergarten.groups[0].id,
                needsSpeechLessons: false,
            });
        });

        test('none before a timetable is published', async () => {
            await request(app).post('/api/schedules').expect(201);

            const { body } = await as(speech.auth)
                .get('/api/groups')
                .expect(200);

            expect(body.total).toBe(0);
        });

        test('the groups where they teach in the published timetable', async () => {
            await publish();

            const { body } = await as(speech.auth)
                .get('/api/groups')
                .expect(200);

            expect(body.items.map((g) => g.id)).toEqual([
                kindergarten.groups[0].id,
            ]);
            await as(speech.auth)
                .get(`/api/groups/${kindergarten.groups[0].id}`)
                .expect(200);
            await as(speech.auth)
                .get(`/api/groups/${kindergarten.groups[1].id}`)
                .expect(403);
        });

        test('the kids of their group: name, sex and age only', async () => {
            await publish();

            const { body } = await as(speech.auth)
                .get(`/api/groups/${kindergarten.groups[0].id}/kids`)
                .query({ sort: 'firstName' })
                .expect(200);

            expect(body.items).toEqual([
                {
                    id: expect.any(String),
                    firstName: 'Marko',
                    lastName: 'Koval',
                    sex: 'MALE',
                    age: kindergarten.groups[0].age,
                },
                {
                    id: expect.any(String),
                    firstName: 'Olia',
                    lastName: 'Lys',
                    sex: 'FEMALE',
                    age: kindergarten.groups[0].age,
                },
            ]);
        });

        test('filters by sex, but not by a field they do not see', async () => {
            await publish();
            const path = `/api/groups/${kindergarten.groups[0].id}/kids`;

            const { body } = await as(speech.auth)
                .get(path)
                .query({ where: '{"sex":"FEMALE"}' })
                .expect(200);
            const hidden = await as(speech.auth)
                .get(path)
                .query({ where: '{"needsSpeechLessons":true}' })
                .expect(403);

            expect(body.items.map((k) => k.firstName)).toEqual(['Olia']);
            expect(hidden.body.error.message).toBe(
                'Teachers filter and sort the kids of a group only by id, firstName, lastName, sex, age.'
            );
        });

        test('the kids of another group: 403', async () => {
            await publish();

            await as(speech.auth)
                .get(`/api/groups/${kindergarten.groups[1].id}/kids`)
                .expect(403);
        });

        test('no kid records beyond the groups (2.4)', async () => {
            await publish();

            await as(speech.auth).get('/api/kids').expect(403);
        });
    });
});
