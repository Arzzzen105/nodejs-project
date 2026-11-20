import { kidPrice } from './finance-formulas.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/kid-repository.js').KidRepository} KidRepository
 * @typedef {import('../repositories/discount-repository.js').DiscountRepository} DiscountRepository
 * @typedef {import('./settings-service.js').SettingsService} SettingsService
 * @typedef {import('./access-policy.js').AccessPolicy} AccessPolicy
 */

/**
 * Money of the kindergarten (EPIC-04): what a kid costs, what the
 * kindergarten earns and spends, and what it would with other numbers of
 * kids. Nothing is stored: every answer is counted from the current records
 * and the settings, by the formulas of finance-formulas.js.
 */
export class FinanceService {
    #uow;
    #kids;
    #discounts;
    #settings;
    #access;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {KidRepository} dependencies.kids
     * @param {DiscountRepository} dependencies.discounts
     * @param {SettingsService} dependencies.settings
     * @param {AccessPolicy} dependencies.access Which kids the actor sees
     */
    constructor({ uow, kids, discounts, settings, access }) {
        this.#uow = uow;
        this.#kids = kids;
        this.#discounts = discounts;
        this.#settings = settings;
        this.#access = access;
    }

    /**
     * What a kid costs their parents (FR-012, FR-013), line by line.
     * @param {string} kidId UUIDv7
     * @param {import('./access-policy.js').Actor} [actor]
     * @throws {Error} 404 NOT_FOUND if there is no such kid
     * @throws {HttpError} 403 FORBIDDEN if the kid is not one the actor sees
     */
    async kidPrice(kidId, actor) {
        return this.#uow.run(async () => {
            const kid = await this.#kids.getById(kidId);
            await this.#access.assertKid(actor, kid);
            const discount = kid.discountId
                ? await this.#discounts.getById(kid.discountId)
                : null;
            const settings = await this.#settings.get();
            return {
                kidId,
                ...kidPrice(settings, kid, discount?.rate ?? 0),
            };
        });
    }
}
