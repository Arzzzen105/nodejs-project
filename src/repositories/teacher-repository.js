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

    /**
     * A page of the teachers who teach a subject.
     * @param {string} subjectId UUIDv7
     * @param {object} [query] As for {@link BaseRepository#findPage}
     */
    async findPageBySubject(subjectId, query) {
        return this.findPageWhere(query, {
            subjectIds: { contains: subjectId },
        });
    }
}
