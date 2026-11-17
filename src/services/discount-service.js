/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/discount-repository.js').DiscountRepository} DiscountRepository
 * @typedef {import('../repositories/kid-repository.js').KidRepository} KidRepository
 */

/**
 * Use cases for discounts. CRUD passes the call to the repository as is;
 * related records are read in one transaction with the check that the
 * discount exists.
 */
export class DiscountService {
    #uow;
    #discounts;
    #kids;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {DiscountRepository} dependencies.discounts
     * @param {KidRepository} dependencies.kids
     */
    constructor({ uow, discounts, kids }) {
        this.#uow = uow;
        this.#discounts = discounts;
        this.#kids = kids;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#discounts.findPage(query);
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#discounts.findById(id);
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return this.#discounts.getById(id);
    }

    /** @see BaseRepository#create */
    async create(data) {
        return this.#discounts.create(data);
    }

    /** @see BaseRepository#replace */
    async replace(id, data) {
        return this.#discounts.replace(id, data);
    }

    /** @see BaseRepository#update */
    async update(id, changes) {
        return this.#discounts.update(id, changes);
    }

    /** @see BaseRepository#delete */
    async delete(id) {
        return this.#discounts.delete(id);
    }

    /**
     * A page of the kids with the discount.
     * @see KidRepository#findPageByDiscount
     * @throws {Error} 404 NOT_FOUND if there is no such discount
     */
    async listKids(id, query) {
        return this.#uow.run(async () => {
            await this.#discounts.getById(id);
            return this.#kids.findPageByDiscount(id, query);
        });
    }
}
