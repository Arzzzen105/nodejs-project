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

    /**
     * The room of a group. A group has at most one: `groupId` is unique.
     * @param {string} groupId UUIDv7
     * @returns {Promise<object|null>}
     */
    async findByGroup(groupId) {
        const page = await this.findPage({ where: { groupId }, limit: 1 });
        return page.items[0] ?? null;
    }
}
