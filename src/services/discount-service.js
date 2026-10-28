/**
 * @typedef {import('../repositories/discount-repository.js').DiscountRepository} DiscountRepository
 */

/**
 * Use cases for discounts. For now every method passes the call to the
 * repository as is; business rules of EPIC-02 are added here.
 */
export class DiscountService {
    #discounts;

    /**
     * @param {object} dependencies
     * @param {DiscountRepository} dependencies.discounts
     */
    constructor({ discounts }) {
        this.#discounts = discounts;
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
}
