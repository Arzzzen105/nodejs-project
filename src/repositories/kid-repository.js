import { eq, or } from '../storage/file-database.js';
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

    /**
     * A page of the kids of a group.
     * @param {string} groupId UUIDv7
     * @param {object} [query] As for {@link BaseRepository#findPage}
     */
    async findPageByGroup(groupId, query) {
        return this.findPageWhere(query, { groupId });
    }

    /**
     * A page of the kids with a discount.
     * @param {string} discountId UUIDv7
     * @param {object} [query] As for {@link BaseRepository#findPage}
     */
    async findPageByDiscount(discountId, query) {
        return this.findPageWhere(query, { discountId });
    }

    /**
     * A page of the kids of a parent, as the mother or as the father. `where`
     * has no "or", so the ids of their kids (a few) are found first.
     * @param {string} parentId UUIDv7
     * @param {object} [query] As for {@link BaseRepository#findPage}
     */
    async findPageByParent(parentId, query) {
        return this.uow.run(async () => {
            const kids = await this.findAll({
                predicate: or(
                    eq('motherId', parentId),
                    eq('fatherId', parentId)
                ),
            });
            return this.findPageWhere(query, {
                id: { in: kids.map((kid) => kid.id) },
            });
        });
    }

    /**
     * Ids of the groups with at least one kid who needs speech lessons
     * (FR-021). Reads only those kids, who are few.
     * @returns {Promise<Set<string>>}
     */
    async findGroupIdsWithSpeechLessons() {
        const kids = await this.findAll({
            where: { needsSpeechLessons: true },
        });
        return new Set(kids.map((kid) => kid.groupId).filter(Boolean));
    }
}
