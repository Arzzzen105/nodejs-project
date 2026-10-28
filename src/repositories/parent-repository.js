import { inList } from '#storage/file-database';
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

    async findByKid(kidId) {
        return this.uow.run(async () => {
            const kid = await this.db.get('kids', kidId);
            return this.findAll({
                predicate: inList('id', [kid.motherId, kid.fatherId]),
            });
        });
    }
}
