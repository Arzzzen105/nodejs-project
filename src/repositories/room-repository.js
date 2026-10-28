import { BaseRepository } from './base-repository.js';

/**
 * Rooms (collection "rooms"). Named queries are added here as
 * services need them.
 */
export class RoomRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'rooms');
    }
}
