import { BaseRepository } from './base-repository.js';

/**
 * Discounts (collection "discounts"). Named queries are added here as
 * services need them.
 */
export class DiscountRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'discounts');
    }
}
