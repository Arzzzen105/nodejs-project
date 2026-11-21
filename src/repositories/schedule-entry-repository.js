import { BaseRepository } from './base-repository.js';

/**
 * Events of timetables (collection "schedule_entries", EPIC-05): lessons,
 * meals and sleep of a group, each in a day and a slot of 15 minutes. They
 * exist only with their timetable, so the schedule service manages them.
 */
export class ScheduleEntryRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'schedule_entries');
    }

    /**
     * Every event of a timetable.
     * @param {string} scheduleId UUIDv7
     * @returns {Promise<object[]>}
     */
    async findBySchedule(scheduleId) {
        return this.findAll({ where: { scheduleId } });
    }

    /**
     * Deletes every event of a timetable, so the timetable itself can be
     * deleted: the database restricts deleting one that still has events.
     * @param {string} scheduleId UUIDv7
     * @returns {Promise<Array<{ deleted: Array, updated: Array }>>}
     */
    async deleteBySchedule(scheduleId) {
        const reports = [];
        for (const entry of await this.findBySchedule(scheduleId)) {
            reports.push(await this.delete(entry.id));
        }
        return reports;
    }
}
