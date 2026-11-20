import { BaseRepository } from './base-repository.js';

/**
 * Financial settings (collection "settings", FR-016): one record with every
 * price, discount and salary. Its defaults, the values of the requirements,
 * live in database/settings/config.json.
 */
export class SettingsRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'settings');
    }

    /**
     * @returns {Promise<object|null>} The record of settings, or null before
     *   it is created
     */
    async findCurrent() {
        const { items } = await this.findPage({ limit: 1 });
        return items[0] ?? null;
    }
}
