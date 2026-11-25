import { forbidden } from '../http-error.js';
import { MANAGEMENT, ROLES } from '../security/roles.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/group-repository.js').GroupRepository} GroupRepository
 * @typedef {import('../repositories/kid-repository.js').KidRepository} KidRepository
 * @typedef {import('../repositories/schedule-repository.js').ScheduleRepository} ScheduleRepository
 * @typedef {import('../repositories/schedule-entry-repository.js').ScheduleEntryRepository} ScheduleEntryRepository
 * @typedef {{ id: string, role: string, parentId?: string|null, educatorId?: string|null, teacherId?: string|null }} Actor
 */

/**
 * Which records a user may see (EPIC-03, TS-03.3, NFR-04). The router already
 * let only the right roles in; this decides which of the records are theirs:
 * - the admin and the manager see everything;
 * - an educator sees their group, its kids and the parents of those kids;
 * - a parent sees themselves, their kids and the groups of their kids;
 * - a teacher sees themselves and the groups they teach in the published
 *   timetable, with the kids in them (2.4 of the requirements).
 *
 * Without an actor the call is made by the system itself (startup, scripts,
 * tests): nothing is restricted. Services ask this policy instead of each
 * knowing the roles, so the rules live in one place.
 */
export class AccessPolicy {
    #uow;
    #groups;
    #kids;
    #schedules;
    #entries;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {GroupRepository} dependencies.groups
     * @param {KidRepository} dependencies.kids
     * @param {ScheduleRepository} dependencies.schedules The groups of a
     *   teacher are those of the published timetable
     * @param {ScheduleEntryRepository} dependencies.entries
     */
    constructor({ uow, groups, kids, schedules, entries }) {
        this.#uow = uow;
        this.#groups = groups;
        this.#kids = kids;
        this.#schedules = schedules;
        this.#entries = entries;
    }

    /**
     * @param {Actor} [actor]
     * @returns {boolean} Whether the actor sees every record
     */
    seesAll(actor) {
        return !actor || MANAGEMENT.includes(actor.role);
    }

    /**
     * The kids an actor sees, as `where` conditions to add to a query.
     * @param {Actor} [actor]
     * @returns {Promise<object|null>} null if they see every kid
     */
    async kidScope(actor) {
        if (this.seesAll(actor)) return null;
        if (actor.role === ROLES.PARENT) {
            return { id: { in: await this.#ownKidIds(actor) } };
        }
        return { groupId: { in: await this.groupIds(actor) } };
    }

    /**
     * The groups an actor sees, as `where` conditions to add to a query.
     * @param {Actor} [actor]
     * @returns {Promise<object|null>} null if they see every group
     */
    async groupScope(actor) {
        if (this.seesAll(actor)) return null;
        return { id: { in: await this.groupIds(actor) } };
    }

    /**
     * The parents an actor sees, as `where` conditions to add to a query.
     * @param {Actor} [actor]
     * @returns {Promise<object|null>} null if they see every parent
     */
    async parentScope(actor) {
        if (this.seesAll(actor)) return null;
        return { id: { in: await this.#parentIds(actor) } };
    }

    /**
     * Records of a kid (invoices, payments) an actor sees, as `where`
     * conditions on their `kidId`: a parent sees those of their kids, other
     * roles but the management none.
     * @param {Actor} [actor]
     * @returns {Promise<object|null>} null if they see every record
     */
    async ownKidScope(actor) {
        if (this.seesAll(actor)) return null;
        const ids =
            actor.role === ROLES.PARENT ? await this.#ownKidIds(actor) : [];
        return { kidId: { in: ids } };
    }

    /**
     * For records of a kid: the actor sees the kid. A record whose kid was
     * deleted is seen only by those who see everything.
     * @param {Actor} [actor]
     * @param {string|null} kidId UUIDv7 of the kid of the record
     * @throws {HttpError} 403 FORBIDDEN if the kid is not theirs
     */
    async assertKidId(actor, kidId) {
        if (this.seesAll(actor)) return;
        const kid = kidId ? await this.#kids.findById(kidId) : null;
        if (!kid) throw notYours();
        await this.assertKid(actor, kid);
    }

    /**
     * Ids of the groups of an educator (one at most), of the kids of a
     * parent, or where a teacher has lessons in the published timetable;
     * none for other roles.
     * @param {Actor} actor
     * @returns {Promise<string[]>}
     */
    async groupIds(actor) {
        if (actor.role === ROLES.EDUCATOR) {
            const group = await this.#groups.findByEducator(actor.educatorId);
            return group ? [group.id] : [];
        }
        if (actor.role === ROLES.PARENT) {
            const kids = await this.#kids.findByParent(actor.parentId);
            return [...new Set(kids.map((kid) => kid.groupId))].filter(Boolean);
        }
        if (actor.role === ROLES.TEACHER) {
            return this.#uow.run(async () => {
                const published =
                    await this.#schedules.findByStatus('PUBLISHED');
                if (!published) return [];
                const lessons = (
                    await this.#entries.findBySchedule(published.id)
                ).filter((entry) => entry.teacherId === actor.teacherId);
                return [...new Set(lessons.map((e) => e.groupId))].filter(
                    Boolean
                );
            });
        }
        return [];
    }

    /**
     * @param {Actor} [actor]
     * @param {object} kid As stored
     * @throws {HttpError} 403 FORBIDDEN if the kid is not theirs
     */
    async assertKid(actor, kid) {
        if (this.seesAll(actor)) return;
        const own =
            actor.role === ROLES.PARENT
                ? isParentOf(actor.parentId, kid)
                : (await this.groupIds(actor)).includes(kid.groupId);
        if (!own) throw notYours();
    }

    /**
     * @param {Actor} [actor]
     * @param {string} groupId UUIDv7
     * @throws {HttpError} 403 FORBIDDEN if the group is not theirs
     */
    async assertGroup(actor, groupId) {
        if (this.seesAll(actor)) return;
        if (!(await this.groupIds(actor)).includes(groupId)) throw notYours();
    }

    /**
     * @param {Actor} [actor]
     * @param {string} parentId UUIDv7
     * @throws {HttpError} 403 FORBIDDEN if the parent is not one they see
     */
    async assertParent(actor, parentId) {
        if (this.seesAll(actor)) return;
        if (!(await this.#parentIds(actor)).includes(parentId)) {
            throw notYours();
        }
    }

    /**
     * For profiles: an educator or a teacher sees only their own record.
     * @param {Actor} [actor]
     * @param {'educatorId'|'teacherId'} field The link of the account
     * @param {string} id UUIDv7 of the record
     * @throws {HttpError} 403 FORBIDDEN if it is someone else's
     */
    assertSelf(actor, field, id) {
        if (this.seesAll(actor)) return;
        if (actor[field] !== id) throw notYours();
    }

    /**
     * A parent sees the discounts of their kids (2.6 of the requirements).
     * @param {Actor} [actor]
     * @param {string} discountId UUIDv7
     * @throws {HttpError} 403 FORBIDDEN if none of their kids has it
     */
    async assertDiscount(actor, discountId) {
        if (this.seesAll(actor)) return;
        const kids =
            actor.role === ROLES.PARENT
                ? await this.#kids.findByParent(actor.parentId)
                : [];
        if (!kids.some((kid) => kid.discountId === discountId)) {
            throw notYours();
        }
    }

    /** @param {Actor} actor */
    async #ownKidIds(actor) {
        const kids = await this.#kids.findByParent(actor.parentId);
        return kids.map((kid) => kid.id);
    }

    /**
     * A parent sees themselves; an educator, the parents of the kids of
     * their group.
     * @param {Actor} actor
     * @returns {Promise<string[]>}
     */
    async #parentIds(actor) {
        if (actor.role === ROLES.PARENT) return [actor.parentId];
        return this.#uow.run(async () => {
            const kids = await this.#kids.findByGroups(
                await this.groupIds(actor)
            );
            const ids = kids.flatMap((kid) => [kid.motherId, kid.fatherId]);
            return [...new Set(ids)].filter(Boolean);
        });
    }
}

/**
 * @param {string} parentId
 * @param {object} kid
 * @returns {boolean}
 */
function isParentOf(parentId, kid) {
    return kid.motherId === parentId || kid.fatherId === parentId;
}

/** @returns {import('../http-error.js').HttpError} 403 FORBIDDEN */
function notYours() {
    return forbidden('This record is not yours to see.');
}

/**
 * Adds the scope of an actor to the client's query. The scope replaces
 * fields of the same name in `where`: the client cannot widen it.
 * @param {object} [query] As for BaseRepository#findPage
 * @param {object|null} scope From a `*Scope` method of AccessPolicy
 * @returns {object} The query to pass on
 */
export function narrow(query = {}, scope) {
    if (!scope) return query;
    return { ...query, where: { ...query.where, ...scope } };
}
