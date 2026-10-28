import { BaseRepository } from './base-repository.js';

/**
 * Kids (collection "kids"). Named queries are added here as
 * services need them.
 */
export class KidRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'kids');
    }

    /**
     * How many kids are in a group, without reading them.
     * @param {string} groupId UUIDv7
     * @returns {Promise<number>}
     */
    async countByGroup(groupId) {
        const page = await this.findPage({ where: { groupId }, limit: 1 });
        return page.total;
    }

    /**
     * How many kids a parent has, without reading them. A parent is either
     * the mother or the father of a kid, never both, so the two counts add up.
     * @param {string} parentId UUIDv7
     * @returns {Promise<number>}
     */
    async countByParent(parentId) {
        return this.uow.run(async () => {
            const asMother = await this.findPage({
                where: { motherId: parentId },
                limit: 1,
            });
            const asFather = await this.findPage({
                where: { fatherId: parentId },
                limit: 1,
            });
            return asMother.total + asFather.total;
        });
    }
}
