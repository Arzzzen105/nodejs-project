import { describe, test, expect } from 'vitest';
import { generateSchedule } from '../../src/services/schedule-generator.js';
import { checkSchedule, slotTime } from '../../src/services/schedule-rules.js';
import { scheduleInput } from '../helpers/schedule-input.js';

describe('checkSchedule', () => {
    const input = scheduleInput({ groups: 4 });
    const valid = generateSchedule(input).entries;

    /** A copy of the valid timetable, changed by `change`. */
    const broken = (change) => {
        const entries = valid.map((entry) => ({ ...entry }));
        change(entries);
        return checkSchedule(entries, input);
    };
    const rules = (violations) => violations.map((v) => v.rule);
    const lessons = (entries, filter = () => true) =>
        entries.filter((e) => e.kind === 'LESSON' && filter(e));

    test('a generated timetable breaks nothing', () => {
        expect(checkSchedule(valid, input)).toEqual([]);
    });

    test('TEACHER_BUSY: a teacher with two groups at once (BR-46)', () => {
        const violations = broken((entries) => {
            const [a, b] = lessons(entries, (e) => e.teacherId === 't-music');
            Object.assign(b, { day: a.day, slot: a.slot });
        });

        expect(rules(violations)).toContain('TEACHER_BUSY');
        expect(
            violations.find((v) => v.rule === 'TEACHER_BUSY').message
        ).toMatch(
            /^Teacher Music teaches two groups at (MON|TUE|WED|THU|FRI) \d\d:\d\d\.$/
        );
    });

    test('GROUP_BUSY: a group at two events at once (BR-47)', () => {
        const violations = broken((entries) => {
            const breakfast = entries.find(
                (e) => e.groupId === 'g01' && e.meal === 'BREAKFAST'
            );
            const lesson = lessons(entries, (e) => e.groupId === 'g01')[0];
            Object.assign(lesson, { day: breakfast.day, slot: breakfast.slot });
        });

        expect(rules(violations)).toContain('GROUP_BUSY');
    });

    test('ROOM_BUSY: two groups in the gym at once (BR-18, FR-009)', () => {
        const violations = broken((entries) => {
            const gym = lessons(entries, (e) => e.roomId === 'gym');
            const other = gym.find((e) => e.groupId !== gym[0].groupId);
            Object.assign(other, {
                day: gym[0].day,
                slot: gym[0].slot,
                teacherId: other.teacherId,
            });
        });

        expect(rules(violations)).toContain('ROOM_BUSY');
    });

    test('SUBJECT_IN_A_ROW: the same subject twice in a row (BR-61)', () => {
        const violations = broken((entries) => {
            const [first, second] = lessons(
                entries,
                (e) => e.groupId === 'g00' && e.subjectId === 'chess'
            );
            // right after the first, on a day cleared of everything else
            for (const e of entries) {
                if (e.groupId === 'g00' && e.day === first.day && e !== first) {
                    if (e.kind === 'LESSON' && e !== second) e.day = 'X';
                }
            }
            Object.assign(second, {
                day: first.day,
                slot: first.slot + first.length,
            });
        });

        expect(rules(violations)).toContain('SUBJECT_IN_A_ROW');
    });

    test('ROUTINE: a day without sleep (BR-43)', () => {
        const entries = valid.filter(
            (e) =>
                !(e.groupId === 'g02' && e.day === 'WED' && e.kind === 'SLEEP')
        );

        const violations = checkSchedule(entries, input);

        expect(violations).toContainEqual({
            rule: 'ROUTINE',
            message:
                'Group 2 needs one sleep of 60 minutes starting 12:30–14:00 on WED.',
        });
    });

    test('ROUTINE: a lunch out of its window (BR-44)', () => {
        const violations = broken((entries) => {
            entries.find(
                (e) => e.groupId === 'g00' && e.meal === 'LUNCH'
            ).slot = 4;
        });

        expect(rules(violations)).toContain('ROUTINE');
    });

    test('MEALS_IN_A_ROW: a snack right after lunch (BR-45)', () => {
        const violations = broken((entries) => {
            const day = (e) => e.groupId === 'g00' && e.day === 'MON';
            const lunch = entries.find((e) => day(e) && e.meal === 'LUNCH');
            const snack = entries.find((e) => day(e) && e.meal === 'SNACK');
            for (const e of entries) {
                if (day(e) && e.kind !== 'MEAL') e.day = 'X';
            }
            snack.slot = lunch.slot + lunch.length;
        });

        expect(rules(violations)).toContain('MEALS_IN_A_ROW');
    });

    test('TEACHER_SUBJECT: a teacher of another subject (BR-46, 2.4)', () => {
        const violations = broken((entries) => {
            lessons(entries, (e) => e.subjectId === 'music')[0].teacherId =
                't-chess';
        });

        expect(rules(violations)).toContain('TEACHER_SUBJECT');
    });

    test('ROOM_SUBJECT: a room of another subject (BR-15)', () => {
        const violations = broken((entries) => {
            lessons(entries, (e) => e.subjectId === 'music')[0].roomId =
                'chess-room';
        });

        expect(rules(violations)).toContain('ROOM_SUBJECT');
    });

    test('LESSON_LENGTH: a lesson longer than lessons are (BR-59)', () => {
        const violations = checkSchedule(
            valid.map((e) =>
                e === lessons(valid)[0] ? { ...e, length: 4 } : e
            ),
            input
        );

        expect(rules(violations)).toContain('LESSON_LENGTH');
    });

    test('LESSON_COUNT: a group short of a lesson, so groups of one age differ (FR-007)', () => {
        const missing = lessons(valid, (e) => e.groupId === 'g01')[0];

        const violations = checkSchedule(
            valid.filter((e) => e !== missing),
            input
        );

        expect(rules(violations)).toEqual(['LESSON_COUNT']);
    });

    test('LESSON_COUNT: speech lessons for a group that does not need them (FR-021)', () => {
        const extra = { ...lessons(valid, (e) => e.subjectId === 'speech')[0] };
        extra.groupId = 'g01';

        expect(rules(checkSchedule([...valid, extra], input))).toContain(
            'LESSON_COUNT'
        );
    });

    test('MISSING_REFERENCE: the teacher was deleted after (BR-53)', () => {
        const violations = broken((entries) => {
            lessons(entries)[0].teacherId = null;
        });

        expect(rules(violations)).toContain('MISSING_REFERENCE');
    });

    test('OUT_OF_DAY: an event ending after 17:00 (BR-42)', () => {
        const violations = broken((entries) => {
            lessons(entries)[0].slot = 31;
        });

        expect(rules(violations)).toContain('OUT_OF_DAY');
    });

    test.each([
        [0, '09:00'],
        [2, '09:30'],
        [10, '11:30'],
        [31, '16:45'],
    ])('slot %i starts at %s', (slot, time) => {
        expect(slotTime(slot)).toBe(time);
    });
});
