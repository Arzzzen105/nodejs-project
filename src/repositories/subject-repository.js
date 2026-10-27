import { BaseRepository } from './base-repository.js';

/**
 * Subjects (collection "subjects"). Named queries are added here as
 * services need them.
 */
export class SubjectRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'subjects');
    }
}
