import { BaseRepository } from './base-repository.js';

/**
 * Assistants (collection "assistants"). Named queries are added here as
 * services need them.
 */
export class AssistantRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'assistants');
    }
}
