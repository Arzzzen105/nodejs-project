import { BaseRepository } from './base-repository.js';

/**
 * Parents (collection "parents"). Named queries are added here as
 * services need them.
 */
export class ParentRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'parents');
    }
}
