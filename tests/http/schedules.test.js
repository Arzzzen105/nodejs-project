import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { createTestApp } from '../helpers/test-app.js';
import { seedKindergarten } from '../helpers/kindergarten.js';

describe('/api/schedules (FR-006)', () => {
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

    const generate = async () =>
        (await request(app).post('/api/schedules').expect(201)).body;
    const draftWithEntries = async () => {
        const { id } = await generate();
        return (await request(app).get(`/api/schedules/${id}`).expect(200))
            .body;
    };
    const lessonsOf = (schedule, filter = () => true) =>
        schedule.entries.filter((e) => e.kind === 'LESSON' && filter(e));
    const move = (scheduleId, entryId, body) =>
        request(app)
            .patch(`/api/schedules/${scheduleId}/entries/${entryId}`)
            .send(body);

    describe('POST /api/schedules', () => {
        test('generates a draft for every group', async () => {
            const response = await request(app)
                .post('/api/schedules')
                .expect(201);

            expect(response.headers.location).toBe(
                `/api/schedules/${response.body.id}`
            );
            // 4 groups × (20 meals and sleeps + 5 subjects × 2) + 2 speech
            expect(response.body).toMatchObject({
                status: 'DRAFT',
                publishedAt: null,
                unplaced: [],
                placed: 4 * (20 + 10) + 2,
            });
        });

        test('the draft holds every event, with the times of the grid', async () => {
            const draft = await draftWithEntries();

            expect(draft.entries).toHaveLength(122);
            const breakfast = draft.entries.find((e) => e.meal === 'BREAKFAST');
            expect(breakfast).toMatchObject({ slot: 0, length: 2 });
        });

        test('replaces the previous draft', async () => {
            const first = await generate();

            const second = await generate();

            await request(app).get(`/api/schedules/${first.id}`).expect(404);
            const { body } = await request(app)
                .get('/api/schedules')
                .query({ where: '{"status":"DRAFT"}' })
                .expect(200);
            expect(body.items.map((s) => s.id)).toEqual([second.id]);
        });

        test('lists what it could not place', async () => {
            await repositories.rooms.delete(kindergarten.rooms.chess.id);

            const draft = await generate();

            expect(draft.unplaced).toHaveLength(4);
            expect(draft.unplaced[0]).toMatchObject({
                subjectId: kindergarten.subjects.chess.id,
                missing: 2,
                reason: 'NO_ROOM',
            });
        });

        test('answers 422 for a body', async () => {
            await request(app)
                .post('/api/schedules')
                .send({ groups: 3 })
                .expect(422);
        });
    });

    describe('PATCH /api/schedules/:id/entries/:entryId', () => {
        test('moves a lesson to a free time', async () => {
            // ARRANGE: the last lesson of the day to the end of the day
            const draft = await draftWithEntries();
            const lesson = lessonsOf(draft).at(-1);

            // ACT
            const response = await move(draft.id, lesson.id, { slot: 30 });

            // ASSERT
            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ id: lesson.id, slot: 30 });
        });

        test('answers 409 SCHEDULE_CONFLICT for a teacher who is busy then (BR-46), and changes nothing', async () => {
            // ARRANGE: two music lessons of different groups
            const draft = await draftWithEntries();
            const music = lessonsOf(
                draft,
                (e) => e.subjectId === kindergarten.subjects.music.id
            );
            const a = music[0];
            const b = music.find((e) => e.groupId !== a.groupId);

            // ACT
            const response = await move(draft.id, b.id, {
                day: a.day,
                slot: a.slot,
            });

            // ASSERT
            expect(response.status).toBe(409);
            expect(response.body.error.code).toBe('SCHEDULE_CONFLICT');
            expect(response.body.error.details.map((d) => d.field)).toContain(
                'TEACHER_BUSY'
            );
            const stored = await repositories.schedule_entries.getById(b.id);
            expect(stored).toMatchObject({ day: b.day, slot: b.slot });
        });

        test('answers 409 for a meal out of its window (BR-44)', async () => {
            const draft = await draftWithEntries();
            const lunch = draft.entries.find((e) => e.meal === 'LUNCH');

            const response = await move(draft.id, lunch.id, { slot: 4 });

            expect(response.status).toBe(409);
            expect(response.body.error.details.map((d) => d.field)).toContain(
                'ROUTINE'
            );
        });

        test('answers 422 INVALID_CHANGE for a room of a meal', async () => {
            const draft = await draftWithEntries();
            const lunch = draft.entries.find((e) => e.meal === 'LUNCH');

            const response = await move(draft.id, lunch.id, {
                roomId: kindergarten.rooms.music.id,
            });

            expect(response.status).toBe(422);
            expect(response.body.error.code).toBe('INVALID_CHANGE');
        });

        test('answers 404 for an event of another timetable', async () => {
            const draft = await draftWithEntries();

            await move(uuidv7(), draft.entries[0].id, { slot: 30 }).expect(404);
        });

        test.each([
            ['nothing to change', {}],
            ['a slot past 16:45', { slot: 32 }],
            ['a Saturday', { day: 'SAT' }],
            ['another group', { groupId: uuidv7() }],
        ])('answers 422 for %s', async (name, body) => {
            const draft = await draftWithEntries();

            await move(draft.id, draft.entries[0].id, body).expect(422);
        });
    });

    describe('POST /api/schedules/:id/publish', () => {
        test('publishes a draft that breaks no rule', async () => {
            const draft = await generate();

            const { body } = await request(app)
                .post(`/api/schedules/${draft.id}/publish`)
                .expect(200);

            expect(body.status).toBe('PUBLISHED');
            expect(Date.parse(body.publishedAt)).not.toBeNaN();
        });

        test('a published timetable does not change', async () => {
            const draft = await draftWithEntries();
            await request(app)
                .post(`/api/schedules/${draft.id}/publish`)
                .expect(200);

            const moved = await move(draft.id, lessonsOf(draft).at(-1).id, {
                slot: 30,
            });
            const again = await request(app).post(
                `/api/schedules/${draft.id}/publish`
            );

            expect(moved.status).toBe(409);
            expect(moved.body.error.code).toBe('SCHEDULE_NOT_DRAFT');
            expect(again.status).toBe(409);
        });

        test('archives the timetable published before', async () => {
            const first = await generate();
            await request(app).post(`/api/schedules/${first.id}/publish`);
            const second = await generate();

            await request(app)
                .post(`/api/schedules/${second.id}/publish`)
                .expect(200);

            const { body } = await request(app)
                .get(`/api/schedules/${first.id}`)
                .expect(200);
            expect(body.status).toBe('ARCHIVED');
        });

        test('refuses a draft with lessons left unplaced: groups of one age would differ (FR-007)', async () => {
            await repositories.rooms.delete(kindergarten.rooms.chess.id);
            const draft = await generate();

            const response = await request(app)
                .post(`/api/schedules/${draft.id}/publish`)
                .expect(409);

            expect(response.body.error.code).toBe('SCHEDULE_INVALID');
            expect(
                response.body.error.details.every(
                    (d) => d.field === 'LESSON_COUNT'
                )
            ).toBe(true);
            const { body } = await request(app).get(
                `/api/schedules/${draft.id}`
            );
            expect(body.status).toBe('DRAFT');
        });

        test('refuses a draft whose teacher was deleted since (BR-53)', async () => {
            const draft = await generate();
            await request(app)
                .delete(`/api/teachers/${kindergarten.teachers.music.id}`)
                .expect(204);

            const response = await request(app)
                .post(`/api/schedules/${draft.id}/publish`)
                .expect(409);

            expect(response.body.error.details.map((d) => d.field)).toContain(
                'MISSING_REFERENCE'
            );
        });

        test('refuses a draft made with another length of lessons (BR-59)', async () => {
            const draft = await generate();
            await request(app)
                .patch('/api/finance/settings')
                .send({ lessonMinutes: 45 })
                .expect(200);

            const response = await request(app)
                .post(`/api/schedules/${draft.id}/publish`)
                .expect(409);

            expect(response.body.error.details.map((d) => d.field)).toContain(
                'LESSON_LENGTH'
            );
        });
    });

    describe('a teacher (2.4)', () => {
        let teacher;

        beforeEach(async () => {
            teacher = await signIn({
                role: 'TEACHER',
                teacherId: kindergarten.teachers.music.id,
            });
        });

        const asTeacher = (method, path) =>
            request(rawApp)[method](path).set(teacher.auth);

        test('sees only their own lessons of a draft', async () => {
            const { id } = await generate();

            const { body } = await asTeacher(
                'get',
                `/api/schedules/${id}`
            ).expect(200);

            expect(body.entries.length).toBe(8);
            expect(
                body.entries.every(
                    (e) => e.teacherId === kindergarten.teachers.music.id
                )
            ).toBe(true);
        });

        test('moves their own lesson', async () => {
            const draft = await draftWithEntries();
            const own = lessonsOf(
                draft,
                (e) => e.teacherId === kindergarten.teachers.music.id
            ).at(-1);

            const response = await asTeacher(
                'patch',
                `/api/schedules/${draft.id}/entries/${own.id}`
            ).send({ slot: 30 });

            expect(response.status).toBe(200);
        });

        test('answers 403 for a lesson of another teacher', async () => {
            const draft = await draftWithEntries();
            const other = lessonsOf(
                draft,
                (e) => e.teacherId === kindergarten.teachers.chess.id
            ).at(-1);

            await asTeacher(
                'patch',
                `/api/schedules/${draft.id}/entries/${other.id}`
            )
                .send({ slot: 30 })
                .expect(403);
        });

        test('answers 403 for a meal: only lessons are theirs', async () => {
            const draft = await draftWithEntries();
            const lunch = draft.entries.find((e) => e.meal === 'LUNCH');

            await asTeacher(
                'patch',
                `/api/schedules/${draft.id}/entries/${lunch.id}`
            )
                .send({ slot: lunch.slot })
                .expect(403);
        });

        test('cannot give their lesson to another teacher', async () => {
            const draft = await draftWithEntries();
            const own = lessonsOf(
                draft,
                (e) => e.teacherId === kindergarten.teachers.music.id
            )[0];

            const response = await asTeacher(
                'patch',
                `/api/schedules/${draft.id}/entries/${own.id}`
            )
                .send({ teacherId: kindergarten.teachers.chess.id })
                .expect(403);

            expect(response.body.error.message).toBe(
                'A teacher cannot give a lesson to another teacher.'
            );
        });

        test('does not generate, list or publish', async () => {
            const { id } = await generate();

            await asTeacher('post', '/api/schedules').expect(403);
            await asTeacher('get', '/api/schedules').expect(403);
            await asTeacher('post', `/api/schedules/${id}/publish`).expect(403);
        });
    });

    test('the manager generates and publishes', async () => {
        const { auth } = await signIn({ role: 'MANAGER' });

        const { body } = await request(rawApp)
            .post('/api/schedules')
            .set(auth)
            .expect(201);
        await request(rawApp)
            .post(`/api/schedules/${body.id}/publish`)
            .set(auth)
            .expect(200);
    });
});
