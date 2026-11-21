/**
 * Generator of the weekly timetable (EPIC-05, TS-05.2): a constraint
 * satisfaction problem solved by backtracking. Events are placed hardest
 * first (the fewest options first, as FET does); when one has nowhere to go,
 * the previous ones move. A plain function of its input: the same data give
 * the same timetable.
 *
 * The grid: Monday to Friday, 09:00–17:00 (BR-42), slots of 15 minutes.
 */

export const DAYS = Object.freeze(['MON', 'TUE', 'WED', 'THU', 'FRI']);

/** Slots of 15 minutes from 09:00 to 17:00. */
export const SLOTS_PER_DAY = 32;

/** Minutes of one slot. */
export const SLOT_MINUTES = 15;

/**
 * The day routine of a group (FR-008): three meals of 30 minutes (BR-44) and
 * a sleep of 60 minutes (BR-43), each starting within its window. The windows
 * do not touch one another, so meals never come in a row (BR-45); groups may
 * eat and sleep at different times (BR-63).
 */
export const ROUTINE = Object.freeze([
    { kind: 'MEAL', meal: 'BREAKFAST', length: 2, from: 0, to: 0 }, // 09:00
    { kind: 'MEAL', meal: 'LUNCH', length: 2, from: 10, to: 14 }, // 11:30–12:30
    { kind: 'SLEEP', meal: null, length: 4, from: 14, to: 20 }, // 12:30–14:00
    { kind: 'MEAL', meal: 'SNACK', length: 2, from: 24, to: 28 }, // 15:00–16:00
]);

/**
 * @typedef {object} GeneratorInput
 * @property {Array<{ id: string, age: number, attendsSpeechLessons?: boolean }>} groups
 * @property {Array<object>} subjects With `lessonsPerWeekAge2`…`5` and `speechLessons`
 * @property {Array<{ id: string, subjectIds: string[] }>} teachers
 * @property {Array<{ id: string, groupId?: string|null, subjectIds: string[] }>} rooms
 * @property {number} lessonSlots Length of a lesson in slots (lessonMinutes / 15)
 */

/**
 * @typedef {object} Entry An event of the timetable
 * @property {string} groupId
 * @property {string} day One of DAYS
 * @property {number} slot First slot, 0 = 09:00
 * @property {number} length Slots
 * @property {'LESSON'|'MEAL'|'SLEEP'} kind
 * @property {string|null} meal
 * @property {string|null} subjectId
 * @property {string|null} teacherId
 * @property {string|null} roomId
 */

/**
 * @typedef {object} Unplaced Lessons that found no place
 * @property {string} groupId
 * @property {string} subjectId
 * @property {number} missing How many of its lessons a week
 * @property {'NO_TEACHER'|'NO_ROOM'|'NO_FREE_SLOT'} reason
 */

/**
 * Generates a timetable for every group:
 * - each day a breakfast, a lunch, a snack and a sleep in their windows
 *   (BR-43–BR-45, BR-52, BR-63);
 * - each subject as many times a week as set for the age of the group, the
 *   lessons of the speech therapist only for the groups that need them
 *   (BR-48, BR-54, FR-007, FR-021);
 * - a lesson is taught by a teacher of its subject in a room of its subject
 *   (BR-14, BR-15, BR-18);
 * - a group, a teacher and a room do one thing at a time (BR-46, BR-47);
 * - a subject never comes twice in a row for a group (BR-61);
 * - the lessons of a subject go to different days where they can.
 * @param {GeneratorInput} input
 * @param {object} [options]
 * @param {number} [options.maxSteps=20000] Placements tried in one attempt
 * @param {number} [options.attempts=3] Attempts, each with a shuffled order
 * @returns {{ entries: Entry[], unplaced: Unplaced[] }}
 */
export function generateSchedule(
    input,
    { maxSteps = 20000, attempts = 3 } = {}
) {
    const { events, unplaced } = buildEvents(input);
    const random = seededRandom(1);
    for (let attempt = 0; attempt < attempts; attempt++) {
        const ordered = order(events, attempt === 0 ? null : random);
        const placed = solve(ordered, input.lessonSlots, maxSteps);
        if (placed) return { entries: sortEntries(placed), unplaced };
    }
    // no attempt placed everything: place what fits and report the rest
    const { entries, missed } = placeGreedily(
        order(events, null),
        input.lessonSlots
    );
    return {
        entries: sortEntries(entries),
        unplaced: [...unplaced, ...missed],
    };
}

/**
 * The events to place, and the lessons that cannot be placed at all because
 * nobody teaches the subject or no room is for it.
 * @param {GeneratorInput} input
 */
function buildEvents({ groups, subjects, teachers, rooms }) {
    const events = [];
    const unplaced = [];
    groups.forEach((group, index) => {
        for (const day of DAYS) {
            for (const routine of ROUTINE) {
                events.push({ type: 'ROUTINE', group, index, day, routine });
            }
        }
        for (const subject of subjects) {
            if (subject.speechLessons && !group.attendsSpeechLessons) continue;
            const count = subject[`lessonsPerWeekAge${group.age}`] ?? 0;
            if (count === 0) continue;
            const ownTeachers = teachers
                .filter((t) => t.subjectIds?.includes(subject.id))
                .map((t) => t.id);
            const ownRooms = rooms
                .filter((r) => !r.groupId && r.subjectIds?.includes(subject.id))
                .map((r) => r.id);
            const reason = !ownTeachers.length
                ? 'NO_TEACHER'
                : !ownRooms.length
                  ? 'NO_ROOM'
                  : null;
            if (reason) {
                unplaced.push({
                    groupId: group.id,
                    subjectId: subject.id,
                    missing: count,
                    reason,
                });
                continue;
            }
            for (let n = 0; n < count; n++) {
                events.push({
                    type: 'LESSON',
                    round: n,
                    group,
                    subject,
                    teachers: ownTeachers,
                    rooms: ownRooms,
                });
            }
        }
    });
    return { events, unplaced };
}

/**
 * Hardest first: the routine (few options, and it shapes the day), then the
 * lessons with the fewest teachers and rooms. Of lessons equally hard, the
 * first lesson of every group goes before the second of any, so no group is
 * left with only the slots the others did not take. Lessons of equal
 * difficulty are shuffled after the first attempt.
 * @param {object[]} events
 * @param {(() => number)|null} random
 */
function order(events, random) {
    const keyed = events.map((event, position) => ({
        event,
        position,
        tie: random ? random() : position,
    }));
    const options = (event) =>
        event.type === 'ROUTINE'
            ? 0
            : event.teachers.length * event.rooms.length;
    const round = (event) => event.round ?? 0;
    keyed.sort(
        (a, b) =>
            options(a.event) - options(b.event) ||
            round(a.event) - round(b.event) ||
            a.tie - b.tie ||
            a.position - b.position
    );
    return keyed.map((entry) => entry.event);
}

/**
 * Backtracking over the ordered events.
 * @returns {Entry[]|null} Every event placed, or null when out of steps
 */
function solve(events, lessonSlots, maxSteps) {
    const state = new State();
    const placed = [];
    let steps = 0;
    const place = (index) => {
        if (index === events.length) return true;
        for (const option of options(events[index], state, lessonSlots)) {
            if (++steps > maxSteps) return false;
            state.take(option);
            placed.push(option);
            if (place(index + 1)) return true;
            placed.pop();
            state.free(option);
            if (steps > maxSteps) return false;
        }
        return false;
    };
    return place(0) ? placed : null;
}

/**
 * Places what fits, in order, without moving anything back.
 * @returns {{ entries: Entry[], missed: Unplaced[] }}
 */
function placeGreedily(events, lessonSlots) {
    const state = new State();
    const entries = [];
    const missed = new Map();
    for (const event of events) {
        const { value: option } = options(event, state, lessonSlots).next();
        if (option) {
            state.take(option);
            entries.push(option);
        } else if (event.type === 'LESSON') {
            const key = `${event.group.id}|${event.subject.id}`;
            const entry = missed.get(key) ?? {
                groupId: event.group.id,
                subjectId: event.subject.id,
                missing: 0,
                reason: 'NO_FREE_SLOT',
            };
            entry.missing++;
            missed.set(key, entry);
        }
    }
    return { entries, missed: [...missed.values()] };
}

/**
 * Every place an event can go now, best first, one at a time: the search
 * mostly needs the first few, so they are not all built up front.
 * @returns {Generator<Entry>}
 */
function options(event, state, lessonSlots) {
    return event.type === 'ROUTINE'
        ? routineOptions(event, state)
        : lessonOptions(event, state, lessonSlots);
}

/**
 * Starts within the window of the routine, beginning at a point that moves
 * with the group, so that groups eat and sleep at different times (BR-63).
 */
function* routineOptions({ group, index, day, routine }, state) {
    const starts = [];
    for (let slot = routine.from; slot <= routine.to; slot++) starts.push(slot);
    const shift = index % starts.length;
    for (const slot of [...starts.slice(shift), ...starts.slice(0, shift)]) {
        if (!state.groupFree(group.id, day, slot, routine.length)) continue;
        yield {
            groupId: group.id,
            day,
            slot,
            length: routine.length,
            kind: routine.kind,
            meal: routine.meal,
            subjectId: null,
            teacherId: null,
            roomId: null,
        };
    }
}

/**
 * Every free day, slot, teacher and room for a lesson. Days where the group
 * has this subject least come first, then days with fewer lessons; the
 * teacher who already teaches it to the group comes first.
 */
function* lessonOptions({ group, subject, teachers, rooms }, state, length) {
    const days = [...DAYS].sort(
        (a, b) =>
            state.subjectCount(group.id, subject.id, a) -
                state.subjectCount(group.id, subject.id, b) ||
            state.lessonCount(group.id, a) - state.lessonCount(group.id, b) ||
            DAYS.indexOf(a) - DAYS.indexOf(b)
    );
    const usual = state.teacherOf(group.id, subject.id);
    const ownTeachers = usual
        ? [usual, ...teachers.filter((id) => id !== usual)]
        : teachers;
    for (const day of days) {
        for (let slot = 0; slot + length <= SLOTS_PER_DAY; slot++) {
            if (!state.groupFree(group.id, day, slot, length)) continue;
            // BR-61: not right after, nor right before, the same subject
            if (state.subjectAt(group.id, day, slot - 1) === subject.id)
                continue;
            if (state.subjectAt(group.id, day, slot + length) === subject.id) {
                continue;
            }
            for (const teacherId of ownTeachers) {
                if (!state.teacherFree(teacherId, day, slot, length)) continue;
                for (const roomId of rooms) {
                    if (!state.roomFree(roomId, day, slot, length)) continue;
                    yield {
                        groupId: group.id,
                        day,
                        slot,
                        length,
                        kind: 'LESSON',
                        meal: null,
                        subjectId: subject.id,
                        teacherId,
                        roomId,
                    };
                }
            }
        }
    }
}

/**
 * What is taken: for each group, teacher and room, which slots of which day.
 */
class State {
    #busy = new Map();
    #subjects = new Map();
    #counts = new Map();
    #teachers = new Map();

    #slots(key) {
        let slots = this.#busy.get(key);
        if (!slots) {
            slots = new Array(SLOTS_PER_DAY).fill(false);
            this.#busy.set(key, slots);
        }
        return slots;
    }

    #free(key, slot, length) {
        if (slot < 0 || slot + length > SLOTS_PER_DAY) return false;
        const slots = this.#slots(key);
        for (let s = slot; s < slot + length; s++) if (slots[s]) return false;
        return true;
    }

    #mark(key, slot, length, value) {
        const slots = this.#slots(key);
        for (let s = slot; s < slot + length; s++) slots[s] = value;
    }

    groupFree(id, day, slot, length) {
        return this.#free(`g|${id}|${day}`, slot, length);
    }

    teacherFree(id, day, slot, length) {
        return this.#free(`t|${id}|${day}`, slot, length);
    }

    roomFree(id, day, slot, length) {
        return this.#free(`r|${id}|${day}`, slot, length);
    }

    /** The subject of the group's lesson that covers the slot, if any. */
    subjectAt(groupId, day, slot) {
        return this.#subjects.get(`${groupId}|${day}|${slot}`) ?? null;
    }

    subjectCount(groupId, subjectId, day) {
        return this.#counts.get(`${groupId}|${subjectId}|${day}`) ?? 0;
    }

    lessonCount(groupId, day) {
        return this.#counts.get(`${groupId}|*|${day}`) ?? 0;
    }

    teacherOf(groupId, subjectId) {
        return this.#teachers.get(`${groupId}|${subjectId}`)?.teacherId ?? null;
    }

    take(entry) {
        this.#apply(entry, true);
    }

    free(entry) {
        this.#apply(entry, false);
    }

    #apply(entry, taking) {
        const { groupId, day, slot, length } = entry;
        this.#mark(`g|${groupId}|${day}`, slot, length, taking);
        if (entry.kind !== 'LESSON') return;
        this.#mark(`t|${entry.teacherId}|${day}`, slot, length, taking);
        this.#mark(`r|${entry.roomId}|${day}`, slot, length, taking);
        for (let s = slot; s < slot + length; s++) {
            const key = `${groupId}|${day}|${s}`;
            if (taking) this.#subjects.set(key, entry.subjectId);
            else this.#subjects.delete(key);
        }
        const step = taking ? 1 : -1;
        for (const key of [
            `${groupId}|${entry.subjectId}|${day}`,
            `${groupId}|*|${day}`,
        ]) {
            this.#counts.set(key, (this.#counts.get(key) ?? 0) + step);
        }
        // the first teacher of a subject in a group stays its usual one
        const teacherKey = `${groupId}|${entry.subjectId}`;
        const usual = this.#teachers.get(teacherKey);
        if (taking && !usual) {
            this.#teachers.set(teacherKey, {
                teacherId: entry.teacherId,
                uses: 1,
            });
        } else if (usual && usual.teacherId === entry.teacherId) {
            usual.uses += step;
            if (usual.uses === 0) this.#teachers.delete(teacherKey);
        }
    }
}

/**
 * @param {Entry[]} entries
 * @returns {Entry[]} By group, day and slot
 */
function sortEntries(entries) {
    return [...entries].sort(
        (a, b) =>
            (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0) ||
            DAYS.indexOf(a.day) - DAYS.indexOf(b.day) ||
            a.slot - b.slot
    );
}

/**
 * A small deterministic random generator (mulberry32): the same seed gives
 * the same numbers, so a shuffled attempt is repeatable.
 * @param {number} seed
 * @returns {() => number} Numbers in [0, 1)
 */
function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
