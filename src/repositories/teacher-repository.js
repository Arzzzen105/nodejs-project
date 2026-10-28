import { BaseRepository } from './base-repository.js';

/**
 * Teachers (collection "teachers"). Named queries are added here as
 * services need them.
 */
export class TeacherRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'teachers');
    }
}
