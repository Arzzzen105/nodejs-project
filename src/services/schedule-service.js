/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/schedule-repository.js').ScheduleRepository} ScheduleRepository
 * @typedef {import('../repositories/schedule-entry-repository.js').ScheduleEntryRepository} ScheduleEntryRepository
 */

/**
 * Use cases for timetables (EPIC-05). A timetable and its events are managed
 * together here, as the events exist only with their timetable. Generating,
 * editing and publishing come in the next steps of the epic.
 */
export class ScheduleService {
    #uow;
    #schedules;
    #entries;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {ScheduleRepository} dependencies.schedules
     * @param {ScheduleEntryRepository} dependencies.entries
     */
    constructor({ uow, schedules, entries }) {
        this.#uow = uow;
        this.#schedules = schedules;
        this.#entries = entries;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#schedules.findPage(query);
    }

    /**
     * A timetable with every event of it.
     * @param {string} id UUIDv7
     * @throws {Error} 404 NOT_FOUND if there is no such timetable
     */
    async get(id) {
        return this.#uow.run(async () => ({
            ...(await this.#schedules.getById(id)),
            entries: await this.#entries.findBySchedule(id),
        }));
    }
}
