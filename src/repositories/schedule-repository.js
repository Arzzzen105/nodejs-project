import { BaseRepository } from './base-repository.js';

/**
 * Timetables (collection "schedules", EPIC-05): a draft, the published one
 * and the archived ones. Their events are in ScheduleEntryRepository.
 */
export class ScheduleRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'schedules');
    }

    /**
     * @param {'DRAFT'|'PUBLISHED'|'ARCHIVED'} status
     * @returns {Promise<object|null>} The timetable with the status, or null;
     *   there is at most one draft and one published timetable
     */
    async findByStatus(status) {
        const { items } = await this.findPage({
            where: { status },
            limit: 1,
        });
        return items[0] ?? null;
    }
}
