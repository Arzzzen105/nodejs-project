import { describe, test, expect } from 'vitest';
import {
    DAYS,
    ROUTINE,
    generateSchedule,
} from '../../src/services/schedule-generator.js';
import { checkSchedule } from '../../src/services/schedule-rules.js';
import { scheduleInput } from '../helpers/schedule-input.js';

const lessonsOf = (entries, groupId, subjectId) =>
    entries.filter(
        (e) =>
            e.kind === 'LESSON' &&
            e.groupId === groupId &&
            (!subjectId || e.subjectId === subjectId)
    );

describe('generateSchedule (TS-05.2)', () => {
    describe('the kindergarten of the requirements: 15 groups, 6 subjects', () => {
        const input = scheduleInput();
        const { entries, unplaced } = generateSchedule(input);

        test('places every lesson and breaks no rule', () => {
            expect(unplaced).toEqual([]);
            expect(checkSchedule(entries, input)).toEqual([]);
        });

        test('every group eats three times and sleeps once a day, in the windows (BR-43, BR-44, BR-52)', () => {
            for (const group of input.groups) {
                for (const day of DAYS) {
                    const routine = entries.filter(
                        (e) =>
                            e.groupId === group.id &&
                            e.day === day &&
                            e.kind !== 'LESSON'
                    );
                    expect(
                        routine.map((e) => e.meal ?? 'SLEEP').sort()
                    ).toEqual(['BREAKFAST', 'LUNCH', 'SLEEP', 'SNACK']);
                    for (const event of routine) {
                        const window = ROUTINE.find(
                            (r) =>
                                (r.meal ?? 'SLEEP') === (event.meal ?? 'SLEEP')
                        );
                        expect(event.slot).toBeGreaterThanOrEqual(window.from);
                        expect(event.slot).toBeLessThanOrEqual(window.to);
                    }
                }
            }
        });

        test('groups may eat and sleep at different times (BR-63)', () => {
            const lunches = new Set(
                entries
                    .filter((e) => e.meal === 'LUNCH' && e.day === 'MON')
                    .map((e) => e.slot)
            );

            expect(lunches.size).toBeGreaterThan(1);
        });

        test('lessons of the speech therapist only for the groups that need them (FR-021)', () => {
            for (const group of input.groups) {
                expect(lessonsOf(entries, group.id, 'speech')).toHaveLength(
                    group.attendsSpeechLessons ? 2 : 0
                );
            }
        });

        test('the two lessons of a subject go to different days', () => {
            for (const group of input.groups) {
                for (const subject of input.subjects) {
                    const days = lessonsOf(entries, group.id, subject.id).map(
                        (e) => e.day
                    );
                    expect(new Set(days).size).toBe(days.length);
                }
            }
        });

        test('physical education and wrestling share the gym, one group at a time (BR-18)', () => {
            const gym = entries.filter((e) => e.roomId === 'gym');

            expect(new Set(gym.map((e) => e.subjectId))).toEqual(
                new Set(['pe', 'wrestling'])
            );
            // no overlap: checked by checkSchedule above, ROOM_BUSY
        });

        test('a group keeps one teacher for a subject', () => {
            for (const group of input.groups) {
                for (const subject of input.subjects) {
                    const teachers = new Set(
                        lessonsOf(entries, group.id, subject.id).map(
                            (e) => e.teacherId
                        )
                    );
                    expect(teachers.size).toBeLessThanOrEqual(1);
                }
            }
        });
    });

    test('loads differ by age: groups of one age get alike (BR-54, BR-55)', () => {
        // ARRANGE: music 3 times a week at 2, once at 5
        const input = scheduleInput({ groups: 8 });
        Object.assign(
            input.subjects.find((s) => s.id === 'music'),
            {
                lessonsPerWeekAge2: 3,
                lessonsPerWeekAge5: 1,
            }
        );

        // ACT
        const { entries, unplaced } = generateSchedule(input);

        // ASSERT
        expect(unplaced).toEqual([]);
        expect(checkSchedule(entries, input)).toEqual([]);
        for (const group of input.groups) {
            const expected = { 2: 3, 3: 2, 4: 2, 5: 1 }[group.age];
            expect(lessonsOf(entries, group.id, 'music')).toHaveLength(
                expected
            );
        }
    });

    test('a load of 0 leaves the subject out', () => {
        const input = scheduleInput({ groups: 4 });
        Object.assign(
            input.subjects.find((s) => s.id === 'chess'),
            {
                lessonsPerWeekAge2: 0,
            }
        );

        const { entries } = generateSchedule(input);

        expect(lessonsOf(entries, 'g00', 'chess')).toHaveLength(0);
        expect(lessonsOf(entries, 'g01', 'chess')).toHaveLength(2);
    });

    test('lessons last as long as set: 60 minutes (FR-006)', () => {
        const input = scheduleInput({ groups: 6, lessonSlots: 4 });

        const { entries, unplaced } = generateSchedule(input);

        expect(unplaced).toEqual([]);
        expect(checkSchedule(entries, input)).toEqual([]);
        expect(
            entries
                .filter((e) => e.kind === 'LESSON')
                .every((e) => e.length === 4)
        ).toBe(true);
    });

    test('a room of a group is never used for lessons', () => {
        const input = scheduleInput({ groups: 4 });
        input.rooms.push({
            id: 'group-room',
            name: 'Room of a group',
            groupId: 'g00',
            subjectIds: ['music'],
        });

        const { entries } = generateSchedule(input);

        expect(entries.some((e) => e.roomId === 'group-room')).toBe(false);
    });

    test('the same data give the same timetable', () => {
        const input = scheduleInput();

        expect(generateSchedule(input)).toEqual(generateSchedule(input));
    });

    test.each([
        [
            'NO_TEACHER',
            (input) =>
                (input.teachers = input.teachers.filter(
                    (t) => t.id !== 't-chess'
                )),
        ],
        [
            'NO_ROOM',
            (input) =>
                (input.rooms = input.rooms.filter(
                    (r) => r.id !== 'chess-room'
                )),
        ],
    ])('reports %s for a subject nobody can host', (reason, change) => {
        // ARRANGE
        const input = scheduleInput({ groups: 2 });
        change(input);

        // ACT
        const { entries, unplaced } = generateSchedule(input);

        // ASSERT: the rest is placed
        expect(unplaced).toEqual([
            { groupId: 'g00', subjectId: 'chess', missing: 2, reason },
            { groupId: 'g01', subjectId: 'chess', missing: 2, reason },
        ]);
        expect(lessonsOf(entries, 'g00', 'music')).toHaveLength(2);
    });

    test('reports NO_FREE_SLOT when the gym cannot take every group, and places the rest without a conflict', () => {
        // 15 groups × 4 lessons of an hour in the gym = 240 slots; it has 160
        const input = scheduleInput({ lessonSlots: 4 });

        const { entries, unplaced } = generateSchedule(input);

        expect(unplaced.length).toBeGreaterThan(0);
        expect(unplaced.every((u) => u.reason === 'NO_FREE_SLOT')).toBe(true);
        const broken = checkSchedule(entries, input).filter(
            (v) => v.rule !== 'LESSON_COUNT'
        );
        expect(broken).toEqual([]);
    });

    test('no groups, no timetable', () => {
        const input = scheduleInput({ groups: 0 });

        expect(generateSchedule(input)).toEqual({ entries: [], unplaced: [] });
    });
});
