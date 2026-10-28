import { BaseRepository } from './base-repository.js';

/**
 * Educators (collection "educators"). Named queries are added here as
 * services need them.
 */
export class EducatorRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'educators');
    }
}
