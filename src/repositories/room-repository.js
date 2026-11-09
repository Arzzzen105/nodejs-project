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

    /**
     * How many rooms there are, without reading them.
     * @returns {Promise<number>}
     */
    async count() {
        const page = await this.findPage({ limit: 1 });
        return page.total;
    }
}
