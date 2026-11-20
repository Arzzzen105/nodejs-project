/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/settings-repository.js').SettingsRepository} SettingsRepository
 */

/**
 * Financial settings (FR-016, NFR-06): prices, discounts and salaries the
 * admin changes without a change of code. There is one record; it is created
 * with the defaults of the database schema (the values of the requirements)
 * the first time it is needed, so a new database works at once.
 */
export class SettingsService {
    #uow;
    #settings;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {SettingsRepository} dependencies.settings
     */
    constructor({ uow, settings }) {
        this.#uow = uow;
        this.#settings = settings;
    }

    /**
     * @returns {Promise<object>} The current settings
     */
    async get() {
        return this.#uow.run(
            async () =>
                (await this.#settings.findCurrent()) ??
                this.#settings.create({})
        );
    }

    /**
     * Changes some of the settings (PATCH). The database checks the ranges:
     * amounts are not negative, discounts are between 0 and 1.
     * @param {object} changes
     * @returns {Promise<object>} The settings after the change
     * @throws {Error} 422 VALIDATION_ERROR for a value out of range
     */
    async update(changes) {
        return this.#uow.run(async () => {
            const { id } = await this.get();
            return this.#settings.update(id, changes);
        });
    }
}
