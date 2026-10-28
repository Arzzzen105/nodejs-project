import { BaseRepository } from './base-repository.js';

/**
 * Groups (collection "groups"). Named queries are added here as
 * services need them.
 */
export class GroupRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'groups');
    }
}
