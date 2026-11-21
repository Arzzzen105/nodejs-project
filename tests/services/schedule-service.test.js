import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { FileDatabase } from '../../src/storage/file-database.js';
import { createContainer } from '../../src/container.js';
import { copySchema } from '../../scripts/copy-schema.js';
import { createTempDir, removeDir } from '../helpers/temp-db.js';

const SCHEMA = path.resolve(import.meta.dirname, '..', '..', 'database');

describe('timetables: data (TS-05.1)', () => {
    let root;
    let db;
    let services;
    let repositories;

    beforeEach(async () => {
        root = await createTempDir();
        await copySchema(SCHEMA, root);
        db = await new FileDatabase(root).init();
        ({ services, repositories } = createContainer(db));
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    /** A timetable with one lesson of a group, past the service. */
    const lessonInTimetable = async () => {
        const subject = await repositories.subjects.create({ name: 'Music' });
        const teacher = await repositories.teachers.create({
            firstName: 'Petro',
            lastName: 'Shevchuk',
            subjectIds: [subject.id],
        });
        const room = await repositories.rooms.create({
            name: 'Music hall',
            subjectIds: [subject.id],
        });
        const group = await repositories.groups.create({
            name: 'Sunny',
            age: 3,
        });
        const schedule = await repositories.schedules.create({});
        const entry = await repositories.schedule_entries.create({
            scheduleId: schedule.id,
            groupId: group.id,
            day: 'MON',
            slot: 2,
            length: 2,
            kind: 'LESSON',
            subjectId: subject.id,
            teacherId: teacher.id,
            roomId: room.id,
        });
        return { subject, teacher, room, group, schedule, entry };
    };

    test('a new timetable is a draft with nothing left unplaced', async () => {
        const schedule = await repositories.schedules.create({});

        expect(schedule).toMatchObject({
            status: 'DRAFT',
            publishedAt: null,
            unplaced: [],
        });
    });

    test('get answers the timetable with its events', async () => {
        const { schedule, entry } = await lessonInTimetable();

        const found = await services.schedules.get(schedule.id);

        expect(found).toMatchObject({ id: schedule.id, status: 'DRAFT' });
        expect(found.entries).toEqual([entry]);
    });

    test('get answers 404 for a missing timetable', async () => {
        await expect(services.schedules.get(uuidv7())).rejects.toMatchObject({
            status: 404,
        });
    });

    test('findByStatus finds the draft and the published one', async () => {
        const draft = await repositories.schedules.create({});
        const published = await repositories.schedules.create({
            status: 'PUBLISHED',
        });

        await expect(
            repositories.schedules.findByStatus('DRAFT')
        ).resolves.toEqual(draft);
        await expect(
            repositories.schedules.findByStatus('PUBLISHED')
        ).resolves.toEqual(published);
        await expect(
            repositories.schedules.findByStatus('ARCHIVED')
        ).resolves.toBeNull();
    });

    test('a timetable with events cannot be deleted before them', async () => {
        const { schedule } = await lessonInTimetable();

        await expect(
            repositories.schedules.delete(schedule.id)
        ).rejects.toMatchObject({ code: 'REFERENCE_RESTRICT' });

        await repositories.schedule_entries.deleteBySchedule(schedule.id);
        await repositories.schedules.delete(schedule.id);
        await expect(
            repositories.schedules.findById(schedule.id)
        ).resolves.toBeNull();
    });

    test.each([
        ['teacher', 'teachers', 'teacherId'],
        ['room', 'rooms', 'roomId'],
        ['subject', 'subjects', 'subjectId'],
        ['group', 'groups', 'groupId'],
    ])(
        'deleting the %s keeps the event without it: the timetable is not rebuilt (BR-53)',
        async (name, collection, field) => {
            // ARRANGE
            const records = await lessonInTimetable();
            const record = records[name];

            // ACT
            await services[collection].delete(record.id);

            // ASSERT
            const entry = await repositories.schedule_entries.getById(
                records.entry.id
            );
            expect(entry[field]).toBeNull();
        }
    );

    test.each([
        ['a day off', { day: 'SAT' }],
        ['a slot past 16:45', { slot: 32 }],
        ['longer than an hour', { length: 5 }],
        ['an unknown kind', { kind: 'NAP' }],
        ['an unknown meal', { kind: 'MEAL', meal: 'DINNER' }],
    ])('the database rejects an event on %s', async (name, fields) => {
        const schedule = await repositories.schedules.create({});

        await expect(
            repositories.schedule_entries.create({
                scheduleId: schedule.id,
                day: 'MON',
                slot: 0,
                length: 2,
                kind: 'SLEEP',
                ...fields,
            })
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
});
