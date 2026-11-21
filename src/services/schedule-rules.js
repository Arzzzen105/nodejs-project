import {
    DAYS,
    ROUTINE,
    SLOTS_PER_DAY,
    SLOT_MINUTES,
} from './schedule-generator.js';

/**
 * The rules of a timetable (EPIC-05), checked on a whole one: by the tests of
 * the generator, after every edit of a draft and before publishing (FR-006,
 * NFR-05). The generator keeps them while it places events; this checks the
 * result, whoever made it.
 */

/**
 * @typedef {object} Violation
 * @property {string} rule e.g. 'TEACHER_BUSY'
 * @property {string} message For people, with names when the input has them
 */

/**
 * @param {number} slot
 * @returns {string} The time the slot starts, e.g. '09:30'
 */
export function slotTime(slot) {
    const minutes = 9 * 60 + slot * SLOT_MINUTES;
    const hours = String(Math.floor(minutes / 60)).padStart(2, '0');
    return `${hours}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Every rule a timetable breaks.
 * @param {Array<object>} entries Events, each with an `id` when stored
 * @param {import('./schedule-generator.js').GeneratorInput} input The groups,
 *   subjects, teachers and rooms as they are now; names make messages clearer
 * @returns {Violation[]} Empty for a valid timetable
 */
export function checkSchedule(entries, input) {
    const names = namesOf(input);
    return [
        ...checkReferences(entries, input, names),
        ...checkOverlaps(entries, names),
        ...checkSubjectsInARow(entries, names),
        ...checkRoutine(entries, input, names),
        ...checkLessons(entries, input, names),
        ...checkCounts(entries, input, names),
    ];
}

/** Names of groups, subjects, teachers and rooms by id, for messages. */
function namesOf({ groups = [], subjects = [], teachers = [], rooms = [] }) {
    const person = (t) =>
        t.firstName ? `${t.firstName} ${t.lastName}` : String(t.id);
    return {
        group: new Map(groups.map((g) => [g.id, g.name ?? String(g.id)])),
        subject: new Map(subjects.map((s) => [s.id, s.name ?? String(s.id)])),
        teacher: new Map(teachers.map((t) => [t.id, person(t)])),
        room: new Map(rooms.map((r) => [r.id, r.name ?? String(r.id)])),
    };
}

const at = (entry) => `${entry.day} ${slotTime(entry.slot)}`;

/**
 * Events that lost a group, a teacher, a room or a subject, deleted after
 * the timetable was made (BR-53), or point at ones that do not exist.
 */
function checkReferences(entries, input, names) {
    const violations = [];
    for (const entry of entries) {
        const fields =
            entry.kind === 'LESSON'
                ? ['groupId', 'subjectId', 'teacherId', 'roomId']
                : ['groupId'];
        for (const field of fields) {
            const kind = field.replace('Id', '');
            if (!entry[field] || !names[kind].has(entry[field])) {
                violations.push({
                    rule: 'MISSING_REFERENCE',
                    message: `An event at ${at(entry)} has no ${kind}.`,
                });
            }
        }
        if (entry.slot < 0 || entry.slot + entry.length > SLOTS_PER_DAY) {
            violations.push({
                rule: 'OUT_OF_DAY',
                message: `An event at ${at(entry)} ends after 17:00.`,
            });
        }
    }
    return violations;
}

/**
 * A group (BR-47), a teacher (BR-46) or a room does one thing at a time.
 */
function checkOverlaps(entries, names) {
    const violations = [];
    const resources = [
        ['groupId', 'GROUP_BUSY', 'group', 'has two events'],
        ['teacherId', 'TEACHER_BUSY', 'teacher', 'teaches two groups'],
        ['roomId', 'ROOM_BUSY', 'room', 'hosts two groups'],
    ];
    for (const [field, rule, kind, what] of resources) {
        const taken = new Map();
        for (const entry of entries) {
            if (!entry[field]) continue;
            for (
                let slot = entry.slot;
                slot < entry.slot + entry.length;
                slot++
            ) {
                const key = `${entry[field]}|${entry.day}|${slot}`;
                const other = taken.get(key);
                if (other && other !== entry) {
                    violations.push({
                        rule,
                        message: `${names[kind].get(entry[field]) ?? entry[field]} ${what} at ${entry.day} ${slotTime(slot)}.`,
                    });
                    break;
                }
                taken.set(key, entry);
            }
        }
    }
    return violations;
}

/** A subject never comes twice in a row for a group (BR-61). */
function checkSubjectsInARow(entries, names) {
    const violations = [];
    const lessons = entries.filter((e) => e.kind === 'LESSON' && e.groupId);
    const starts = new Map(
        lessons.map((e) => [`${e.groupId}|${e.day}|${e.slot}`, e])
    );
    for (const lesson of lessons) {
        const next = starts.get(
            `${lesson.groupId}|${lesson.day}|${lesson.slot + lesson.length}`
        );
        if (next && next.subjectId === lesson.subjectId) {
            violations.push({
                rule: 'SUBJECT_IN_A_ROW',
                message: `${names.group.get(lesson.groupId)} has ${names.subject.get(lesson.subjectId) ?? 'a subject'} twice in a row at ${at(lesson)}.`,
            });
        }
    }
    return violations;
}

/**
 * Every day each group has a breakfast, a lunch, a snack and a sleep, each
 * once and in its window (BR-43, BR-44, BR-52), and no two meals in a row
 * (BR-45).
 */
function checkRoutine(entries, input, names) {
    const violations = [];
    for (const group of input.groups) {
        for (const day of DAYS) {
            const own = entries.filter(
                (e) => e.groupId === group.id && e.day === day
            );
            for (const routine of ROUTINE) {
                const found = own.filter(
                    (e) => e.kind === routine.kind && e.meal === routine.meal
                );
                const label = (routine.meal ?? 'SLEEP').toLowerCase();
                const valid =
                    found.length === 1 &&
                    found[0].length === routine.length &&
                    found[0].slot >= routine.from &&
                    found[0].slot <= routine.to;
                if (!valid) {
                    violations.push({
                        rule: 'ROUTINE',
                        message: `${names.group.get(group.id)} needs one ${label} of ${routine.length * SLOT_MINUTES} minutes starting ${slotTime(routine.from)}–${slotTime(routine.to)} on ${day}.`,
                    });
                }
            }
            const meals = own
                .filter((e) => e.kind === 'MEAL')
                .sort((a, b) => a.slot - b.slot);
            for (let n = 1; n < meals.length; n++) {
                const previous = meals[n - 1];
                if (previous.slot + previous.length === meals[n].slot) {
                    violations.push({
                        rule: 'MEALS_IN_A_ROW',
                        message: `${names.group.get(group.id)} has two meals in a row at ${at(meals[n])}.`,
                    });
                }
            }
        }
    }
    return violations;
}

/**
 * A lesson is taught by a teacher of its subject in a room of its subject
 * (BR-14, BR-15, BR-18), and lasts as long as lessons do (BR-59).
 */
function checkLessons(entries, input, names) {
    const violations = [];
    const teachers = new Map(input.teachers.map((t) => [t.id, t]));
    const rooms = new Map(input.rooms.map((r) => [r.id, r]));
    for (const lesson of entries.filter((e) => e.kind === 'LESSON')) {
        const subject = names.subject.get(lesson.subjectId) ?? 'its subject';
        const teacher = teachers.get(lesson.teacherId);
        if (teacher && !teacher.subjectIds?.includes(lesson.subjectId)) {
            violations.push({
                rule: 'TEACHER_SUBJECT',
                message: `${names.teacher.get(teacher.id)} does not teach ${subject} (${at(lesson)}).`,
            });
        }
        const room = rooms.get(lesson.roomId);
        if (
            room &&
            (room.groupId || !room.subjectIds?.includes(lesson.subjectId))
        ) {
            violations.push({
                rule: 'ROOM_SUBJECT',
                message: `${names.room.get(room.id)} is not a room for ${subject} (${at(lesson)}).`,
            });
        }
        if (input.lessonSlots && lesson.length !== input.lessonSlots) {
            violations.push({
                rule: 'LESSON_LENGTH',
                message: `A lesson at ${at(lesson)} lasts ${lesson.length * SLOT_MINUTES} minutes, not ${input.lessonSlots * SLOT_MINUTES}.`,
            });
        }
    }
    return violations;
}

/**
 * Each group has each subject as many times as set for its age, the lessons
 * of the speech therapist only if it attends them: so groups of one age have
 * as many lessons of a subject as one another (BR-48, BR-54, FR-007, FR-021).
 */
function checkCounts(entries, input, names) {
    const violations = [];
    for (const group of input.groups) {
        for (const subject of input.subjects) {
            const expected =
                subject.speechLessons && !group.attendsSpeechLessons
                    ? 0
                    : (subject[`lessonsPerWeekAge${group.age}`] ?? 0);
            const actual = entries.filter(
                (e) =>
                    e.kind === 'LESSON' &&
                    e.groupId === group.id &&
                    e.subjectId === subject.id
            ).length;
            if (actual !== expected) {
                violations.push({
                    rule: 'LESSON_COUNT',
                    message: `${names.group.get(group.id)} has ${actual} lessons of ${names.subject.get(subject.id)} a week, not ${expected}.`,
                });
            }
        }
    }
    return violations;
}
