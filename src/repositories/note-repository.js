import { BaseRepository } from './base-repository.js';

/**
 * Notes (collection "notes"). Named queries are added here as
 * services need them.
 */
export class NoteRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'notes');
    }
}
