import { BaseRepository } from './base-repository.js';

/**
 * Kids (collection "kids"). Named queries are added here as
 * services need them.
 */
export class KidRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'kids');
    }
}
