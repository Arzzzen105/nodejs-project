/**
 * @typedef {import('../services/settings-service.js').SettingsService} SettingsService
 * @typedef {import('../services/finance-service.js').FinanceService} FinanceService
 */

/**
 * HTTP side of /api/finance (EPIC-04): takes what `validate` checked, calls
 * the services. Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class FinanceController {
    #settings;
    #finance;

    /**
     * @param {object} dependencies
     * @param {SettingsService} dependencies.settings
     * @param {FinanceService} dependencies.finance
     */
    constructor({ settings, finance }) {
        this.#settings = settings;
        this.#finance = finance;
    }

    getSettings = async (request, response) => {
        response.json(await this.#settings.get());
    };

    updateSettings = async (request, response) => {
        response.json(await this.#settings.update(request.validated.body));
    };

    report = async (request, response) => {
        response.json(await this.#finance.report());
    };
}
