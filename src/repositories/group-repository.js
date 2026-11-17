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

    /**
     * How many groups there are, without reading them.
     * @returns {Promise<number>}
     */
    async count() {
        const page = await this.findPage({ limit: 1 });
        return page.total;
    }

    /**
     * The group of an educator. An educator has at most one: `educatorId` is unique.
     * @param {string} educatorId UUIDv7
     * @returns {Promise<object|null>}
     */
    async findByEducator(educatorId) {
        const page = await this.findPage({ where: { educatorId }, limit: 1 });
        return page.items[0] ?? null;
    }

    /**
     * The group of an assistant. An assistant has at most one: `assistantId` is unique.
     * @param {string} assistantId UUIDv7
     * @returns {Promise<object|null>}
     */
    async findByAssistant(assistantId) {
        const page = await this.findPage({ where: { assistantId }, limit: 1 });
        return page.items[0] ?? null;
    }
}
