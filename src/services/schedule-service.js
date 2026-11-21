import { StatusCodes } from 'http-status-codes';
import { HttpError, forbidden } from '../http-error.js';
import { ROLES } from '../security/roles.js';
import { SLOT_MINUTES, generateSchedule } from './schedule-generator.js';
import { checkSchedule } from './schedule-rules.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/schedule-repository.js').ScheduleRepository} ScheduleRepository
 * @typedef {import('../repositories/schedule-entry-repository.js').ScheduleEntryRepository} ScheduleEntryRepository
 * @typedef {import('../repositories/group-repository.js').GroupRepository} GroupRepository
 * @typedef {import('../repositories/kid-repository.js').KidRepository} KidRepository
 * @typedef {import('../repositories/subject-repository.js').SubjectRepository} SubjectRepository
 * @typedef {import('../repositories/teacher-repository.js').TeacherRepository} TeacherRepository
 * @typedef {import('../repositories/room-repository.js').RoomRepository} RoomRepository
 * @typedef {import('./settings-service.js').SettingsService} SettingsService
 * @typedef {import('./access-policy.js').Actor} Actor
 */

/**
 * Use cases for timetables (EPIC-05, FR-006). A timetable and its events are
 * managed together here, as the events exist only with their timetable.
 *
 * Rules:
 * - there is at most one draft and one published timetable: generating
 *   replaces the draft, publishing archives the published one;
 * - only a draft changes; a change that brings a new conflict is refused
 *   and changes nothing (FR-006, NFR-10);
 * - publishing checks the whole timetable against the records as they are
 *   now, including that groups of one age have as many lessons of each
 *   subject (FR-007);
 * - a teacher sees and moves only their own lessons, and cannot give one to
 *   another teacher (2.4 of the requirements).
 */
export class ScheduleService {
    #uow;
    #schedules;
    #entries;
    #groups;
    #kids;
    #subjects;
    #teachers;
    #rooms;
    #settings;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {ScheduleRepository} dependencies.schedules
     * @param {ScheduleEntryRepository} dependencies.entries
     * @param {GroupRepository} dependencies.groups
     * @param {KidRepository} dependencies.kids Which groups attend speech lessons
     * @param {SubjectRepository} dependencies.subjects
     * @param {TeacherRepository} dependencies.teachers
     * @param {RoomRepository} dependencies.rooms
     * @param {SettingsService} dependencies.settings The length of a lesson
     */
    constructor({
        uow,
        schedules,
        entries,
        groups,
        kids,
        subjects,
        teachers,
        rooms,
        settings,
    }) {
        this.#uow = uow;
        this.#schedules = schedules;
        this.#entries = entries;
        this.#groups = groups;
        this.#kids = kids;
        this.#subjects = subjects;
        this.#teachers = teachers;
        this.#rooms = rooms;
        this.#settings = settings;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#schedules.findPage(query);
    }

    /**
     * A timetable with its events; a teacher gets only their own lessons.
     * @param {string} id UUIDv7
     * @param {Actor} [actor]
     * @throws {Error} 404 NOT_FOUND if there is no such timetable
     */
    async get(id, actor) {
        return this.#uow.run(async () => {
            const schedule = await this.#schedules.getById(id);
            let entries = await this.#entries.findBySchedule(id);
            if (actor?.role === ROLES.TEACHER) {
                entries = entries.filter(
                    (entry) => entry.teacherId === actor.teacherId
                );
            }
            return { ...schedule, entries };
        });
    }

    /**
     * Generates a draft for every group from the records as they are now,
     * in place of the previous draft. Lessons that find no place are listed
     * in `unplaced`; such a draft cannot be published until they are placed.
     * @returns {Promise<object>} The draft with how many events it placed
     */
    async generate() {
        return this.#uow.run(async () => {
            const input = await this.#input();
            const { entries, unplaced } = generateSchedule(input);
            const previous = await this.#schedules.findByStatus('DRAFT');
            if (previous) await this.#remove(previous.id);
            const draft = await this.#schedules.create({ unplaced });
            for (const entry of entries) {
                await this.#entries.create({ ...entry, scheduleId: draft.id });
            }
            return { ...draft, placed: entries.length };
        });
    }

    /**
     * Moves an event of a draft: another day, slot, room or teacher.
     * @param {string} id UUIDv7 of the timetable
     * @param {string} entryId UUIDv7 of the event
     * @param {{ day?: string, slot?: number, roomId?: string, teacherId?: string }} changes
     * @param {Actor} [actor]
     * @returns {Promise<object>} The event after the change
     * @throws {Error} 404 NOT_FOUND if the timetable has no such event
     * @throws {HttpError} 409 SCHEDULE_NOT_DRAFT, 409 SCHEDULE_CONFLICT with
     *   each new conflict in `details`, 422 INVALID_CHANGE for a room or a
     *   teacher of a meal or a sleep, 403 FORBIDDEN for a lesson of another
     *   teacher or a teacher giving their lesson away
     */
    async moveEntry(id, entryId, changes, actor) {
        return this.#uow.run(async () => {
            const schedule = await this.#schedules.getById(id);
            assertDraft(schedule);
            const entry = await this.#entries.getById(entryId);
            if (entry.scheduleId !== id) throw notFound();
            assertMayMove(entry, changes, actor);
            if (
                entry.kind !== 'LESSON' &&
                (changes.roomId !== undefined ||
                    changes.teacherId !== undefined)
            ) {
                throw new HttpError(
                    StatusCodes.UNPROCESSABLE_ENTITY,
                    'INVALID_CHANGE',
                    'Only a lesson has a room and a teacher.'
                );
            }

            const input = await this.#input();
            const entries = await this.#entries.findBySchedule(id);
            const moved = entries.map((e) =>
                e.id === entryId ? { ...e, ...changes } : e
            );
            const conflicts = newViolations(
                checkSchedule(entries, input),
                checkSchedule(moved, input)
            );
            if (conflicts.length > 0) {
                throw new HttpError(
                    StatusCodes.CONFLICT,
                    'SCHEDULE_CONFLICT',
                    'The change conflicts with the timetable.',
                    conflicts.map((v) => ({
                        field: v.rule,
                        message: v.message,
                    }))
                );
            }
            return this.#entries.update(entryId, changes);
        });
    }

    /**
     * Publishes a draft once it breaks no rule: the published timetable
     * before it is archived.
     * @param {string} id UUIDv7
     * @returns {Promise<object>} The published timetable
     * @throws {HttpError} 409 SCHEDULE_NOT_DRAFT, 409 SCHEDULE_INVALID with
     *   every broken rule in `details`
     */
    async publish(id) {
        return this.#uow.run(async () => {
            const schedule = await this.#schedules.getById(id);
            assertDraft(schedule);
            const input = await this.#input();
            const entries = await this.#entries.findBySchedule(id);
            const violations = checkSchedule(entries, input);
            if (violations.length > 0) {
                throw new HttpError(
                    StatusCodes.CONFLICT,
                    'SCHEDULE_INVALID',
                    `The timetable breaks ${violations.length} rule(s); fix them or generate it again.`,
                    violations.map((v) => ({
                        field: v.rule,
                        message: v.message,
                    }))
                );
            }
            const published = await this.#schedules.findByStatus('PUBLISHED');
            if (published) {
                await this.#schedules.update(published.id, {
                    status: 'ARCHIVED',
                });
            }
            return this.#schedules.update(id, {
                status: 'PUBLISHED',
                publishedAt: new Date().toISOString(),
            });
        });
    }

    /**
     * The kindergarten as the generator and the rules read it, as it is now.
     * @returns {Promise<import('./schedule-generator.js').GeneratorInput>}
     */
    async #input() {
        const speech = await this.#kids.findGroupIdsWithSpeechLessons();
        const groups = (await this.#groups.findEvery()).map((group) => ({
            ...group,
            attendsSpeechLessons: speech.has(group.id),
        }));
        const { lessonMinutes } = await this.#settings.get();
        return {
            groups,
            subjects: await this.#subjects.findEvery(),
            teachers: await this.#teachers.findEvery(),
            rooms: await this.#rooms.findEvery(),
            lessonSlots: lessonMinutes / SLOT_MINUTES,
        };
    }

    /** Deletes a timetable with its events. */
    async #remove(id) {
        await this.#entries.deleteBySchedule(id);
        await this.#schedules.delete(id);
    }
}

/**
 * @param {object} schedule
 * @throws {HttpError} 409 SCHEDULE_NOT_DRAFT unless it is a draft
 */
function assertDraft(schedule) {
    if (schedule.status !== 'DRAFT') {
        throw new HttpError(
            StatusCodes.CONFLICT,
            'SCHEDULE_NOT_DRAFT',
            `Only a draft changes; this timetable is ${schedule.status.toLowerCase()}.`
        );
    }
}

/**
 * A teacher moves only their own lessons, and keeps them (2.4).
 * @throws {HttpError} 403 FORBIDDEN
 */
function assertMayMove(entry, changes, actor) {
    if (actor?.role !== ROLES.TEACHER) return;
    if (entry.kind !== 'LESSON' || entry.teacherId !== actor.teacherId) {
        throw forbidden('A teacher moves only their own lessons.');
    }
    if (
        changes.teacherId !== undefined &&
        changes.teacherId !== actor.teacherId
    ) {
        throw forbidden('A teacher cannot give a lesson to another teacher.');
    }
}

/**
 * The violations of `after` that `before` did not have: a draft may already
 * break rules (lessons left unplaced, a teacher deleted), and an edit is
 * refused only for what it breaks itself.
 * @param {import('./schedule-rules.js').Violation[]} before
 * @param {import('./schedule-rules.js').Violation[]} after
 */
function newViolations(before, after) {
    const left = new Map();
    for (const v of before) {
        const key = `${v.rule}|${v.message}`;
        left.set(key, (left.get(key) ?? 0) + 1);
    }
    return after.filter((v) => {
        const key = `${v.rule}|${v.message}`;
        const count = left.get(key) ?? 0;
        if (count === 0) return true;
        left.set(key, count - 1);
        return false;
    });
}

/** @returns {HttpError} 404 NOT_FOUND, as for any missing record */
function notFound() {
    return new HttpError(
        StatusCodes.NOT_FOUND,
        'NOT_FOUND',
        'Record not found.'
    );
}
