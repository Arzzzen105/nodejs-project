import { StatusCodes } from 'http-status-codes';
import { HttpError, forbidden } from '../http-error.js';
import { ROLES } from '../security/roles.js';
import { mergeReports } from './delete-report.js';
import { narrow } from './access-policy.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/kid-repository.js').KidRepository} KidRepository
 * @typedef {import('../repositories/parent-repository.js').ParentRepository} ParentRepository
 * @typedef {import('../repositories/group-repository.js').GroupRepository} GroupRepository
 * @typedef {import('../repositories/room-repository.js').RoomRepository} RoomRepository
 * @typedef {import('../repositories/note-repository.js').NoteRepository} NoteRepository
 * @typedef {import('../repositories/user-repository.js').UserRepository} UserRepository
 * @typedef {import('../storage/transaction.js').DeleteReport} DeleteReport
 * @typedef {import('./access-policy.js').AccessPolicy} AccessPolicy
 */

/**
 * Most kids a group may have.
 */
export const MAX_GROUP_SIZE = 20;

/**
 * Use cases for kids. Writes check the business rules on top of what the
 * database checks (schema, references, unique columns):
 * - the mother is FEMALE and the father is MALE;
 * - a kid joins only a group that has a room, an educator and an assistant
 *   (BR-08);
 * - a kid joins only a group of their age (BR-02); a later change of age
 *   keeps them in it (BR-10);
 * - a group takes at most {@link MAX_GROUP_SIZE} kids;
 * - only the admin assigns or changes the discount (BR-26) and the payment
 *   plan (FR-013) of a kid: they are financial values.
 * Writes take the `actor`, the account making the request; without one the
 * call is made by the system itself (scripts, tests).
 * Deleting a kid also deletes what is left without them (FR-018).
 * Each write runs in one transaction, so the checked records cannot change
 * before the write.
 */
export class KidService {
    #uow;
    #kids;
    #parents;
    #groups;
    #rooms;
    #notes;
    #users;
    #access;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {KidRepository} dependencies.kids
     * @param {ParentRepository} dependencies.parents
     * @param {GroupRepository} dependencies.groups
     * @param {RoomRepository} dependencies.rooms
     * @param {NoteRepository} dependencies.notes
     * @param {UserRepository} dependencies.users Accounts of the parents
     *   deleted with the kid
     * @param {AccessPolicy} dependencies.access Which records the
     *   actor sees
     */
    constructor({ uow, kids, parents, groups, rooms, notes, users, access }) {
        this.#uow = uow;
        this.#kids = kids;
        this.#parents = parents;
        this.#groups = groups;
        this.#rooms = rooms;
        this.#notes = notes;
        this.#users = users;
        this.#access = access;
    }

    /**
     * The kids the actor sees: all of them for the management, the kids of
     * their group for an educator, their own for a parent.
     * @see BaseRepository#findPage
     * @param {object} [query]
     * @param {import('./access-policy.js').Actor} [actor]
     */
    async list(query, actor) {
        return this.#uow.run(async () =>
            this.#kids.findPage(
                narrow(query, await this.#access.kidScope(actor))
            )
        );
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#kids.findById(id);
    }

    /**
     * @see BaseRepository#getById
     * @param {string} id UUIDv7
     * @param {import('./access-policy.js').Actor} [actor]
     * @throws {HttpError} 403 FORBIDDEN if the kid is not one the actor sees
     */
    async get(id, actor) {
        return this.#uow.run(async () => {
            const kid = await this.#kids.getById(id);
            await this.#access.assertKid(actor, kid);
            return kid;
        });
    }

    /**
     * @see BaseRepository#create
     * @param {object} data
     * @param {{ role: string }} [actor]
     * @throws {HttpError} 422 MOTHER_NOT_FEMALE, FATHER_NOT_MALE or
     *   GROUP_AGE_MISMATCH, 409 GROUP_NOT_READY or GROUP_FULL, 403 FORBIDDEN
     *   if anyone but the admin sets a discount or a payment plan
     */
    async create(data, actor) {
        assertFinanceKept(actor, FINANCE_DEFAULTS, data);
        return this.#uow.run(async () => {
            await this.#assertRules({}, data);
            return this.#kids.create(data);
        });
    }

    /**
     * @see BaseRepository#replace
     * @throws {HttpError} As {@link KidService#create}
     */
    async replace(id, data, actor) {
        return this.#uow.run(async () => {
            const current = await this.#kids.getById(id);
            // PUT sets a field left out to its default
            assertFinanceKept(actor, current, data);
            await this.#assertRules(current, data);
            return this.#kids.replace(id, data);
        });
    }

    /**
     * @see BaseRepository#update
     * @throws {HttpError} As {@link KidService#create}
     */
    async update(id, changes, actor) {
        return this.#uow.run(async () => {
            const current = await this.#kids.getById(id);
            assertFinanceKept(actor, current, { ...current, ...changes });
            await this.#assertRules(current, { ...current, ...changes });
            return this.#kids.update(id, changes);
        });
    }

    /**
     * Deletes a kid by FR-018, all in one transaction: their notes (the
     * database has no cascade), then the kid, then each parent (with their
     * account) and the group that have no kids left. Educators and assistants stay; rooms lose the
     * group.
     * @param {string} id UUIDv7
     * @returns {Promise<DeleteReport>} Everything deleted or updated, the kid included
     * @throws {Error} 404 NOT_FOUND if there is no such kid
     */
    async delete(id) {
        return this.#uow.run(async () => {
            const kid = await this.#kids.getById(id);
            const reports = await this.#notes.deleteByKid(id);
            reports.push(await this.#kids.delete(id));

            // counted after the delete, which the transaction already sees
            for (const parentId of [kid.motherId, kid.fatherId]) {
                if (
                    parentId &&
                    (await this.#kids.countByParent(parentId)) === 0
                ) {
                    reports.push(
                        ...(await this.#users.deleteByPerson({ parentId })),
                        await this.#parents.delete(parentId)
                    );
                }
            }
            if (
                kid.groupId &&
                (await this.#kids.countByGroup(kid.groupId)) === 0
            ) {
                reports.push(await this.#groups.delete(kid.groupId));
            }

            return mergeReports(reports);
        });
    }

    /**
     * Moves several kids into a group at once (FR-020), all or none, by the
     * rules of a single kid: the group is ready (BR-08), each kid is of its
     * age (BR-02), and the group takes them all (BR-03). Kids already in the
     * group stay as they are and take no new place.
     * @param {string} groupId UUIDv7
     * @param {string[]} kidIds UUIDv7, without repeats
     * @returns {Promise<object[]>} The kids, in the order of `kidIds`
     * @throws {Error} 404 NOT_FOUND if there is no such group
     * @throws {HttpError} 409 GROUP_NOT_READY or GROUP_FULL, 422
     *   KIDS_CANNOT_JOIN with every kid that is missing or of another age
     */
    async joinGroup(groupId, kidIds) {
        return this.#uow.run(async () => {
            const group = await this.#groups.getById(groupId);
            await this.#assertGroupReady(group);

            const kids = [];
            const details = [];
            for (const [index, id] of kidIds.entries()) {
                const kid = await this.#kids.findById(id);
                const field = `kidIds.${index}`;
                if (!kid) {
                    details.push({ field, message: 'Kid not found.' });
                } else if (kid.groupId !== group.id && kid.age !== group.age) {
                    details.push({ field, message: ageMismatch(group) });
                } else {
                    kids.push(kid);
                }
            }
            if (details.length > 0) {
                throw new HttpError(
                    StatusCodes.UNPROCESSABLE_ENTITY,
                    'KIDS_CANNOT_JOIN',
                    'Some kids cannot join the group.',
                    details
                );
            }

            const newcomers = kids.filter((kid) => kid.groupId !== group.id);
            const count = await this.#kids.countByGroup(group.id);
            if (count + newcomers.length > MAX_GROUP_SIZE) {
                throw new HttpError(
                    StatusCodes.CONFLICT,
                    'GROUP_FULL',
                    `The group has ${count} kids and can take ${MAX_GROUP_SIZE - count} more, not ${newcomers.length}.`
                );
            }

            const joined = [];
            for (const kid of kids) {
                joined.push(
                    kid.groupId === group.id
                        ? kid
                        : await this.#kids.update(kid.id, { groupId: group.id })
                );
            }
            return joined;
        });
    }

    /**
     * Checks only what the write changes, so a kid who broke a rule through a
     * change elsewhere (a parent's sex, a group's age or its lost educator,
     * their own age by BR-10) can still be edited.
     * @param {object} current The kid before the write, {} for a new one
     * @param {object} next The kid after the write
     */
    async #assertRules(current, next) {
        if (next.motherId && next.motherId !== current.motherId) {
            await this.#assertParentSex(
                next.motherId,
                'FEMALE',
                'MOTHER_NOT_FEMALE',
                'The mother must be FEMALE.'
            );
        }
        if (next.fatherId && next.fatherId !== current.fatherId) {
            await this.#assertParentSex(
                next.fatherId,
                'MALE',
                'FATHER_NOT_MALE',
                'The father must be MALE.'
            );
        }

        if (next.groupId && next.groupId !== current.groupId) {
            await this.#assertGroupFits(next);
        }
    }

    /**
     * A referenced record, or null if the id is missing or malformed: the
     * database then rejects the write with 422 REFERENCE_NOT_FOUND or
     * VALIDATION_ERROR, as it would without the service.
     * @param {import('../repositories/base-repository.js').BaseRepository} repository
     * @param {unknown} id
     */
    async #findReferenced(repository, id) {
        try {
            return await repository.findById(id);
        } catch (error) {
            // a failed single operation does not doom the transaction
            if (error.code === 'INVALID_ID') return null;
            throw error;
        }
    }

    async #assertParentSex(parentId, sex, code, message) {
        const parent = await this.#findReferenced(this.#parents, parentId);
        if (parent && parent.sex !== sex) {
            throw new HttpError(
                StatusCodes.UNPROCESSABLE_ENTITY,
                code,
                message
            );
        }
    }

    /**
     * @param {object} kid The kid after the write, joining `kid.groupId`
     */
    async #assertGroupFits(kid) {
        const group = await this.#findReferenced(this.#groups, kid.groupId);
        if (!group) return;

        await this.#assertGroupReady(group);
        if (group.age !== kid.age) {
            throw new HttpError(
                StatusCodes.UNPROCESSABLE_ENTITY,
                'GROUP_AGE_MISMATCH',
                ageMismatch(group)
            );
        }
        if ((await this.#kids.countByGroup(group.id)) >= MAX_GROUP_SIZE) {
            throw new HttpError(
                StatusCodes.CONFLICT,
                'GROUP_FULL',
                `The group already has ${MAX_GROUP_SIZE} kids.`
            );
        }
    }

    /**
     * A group kids may join has a room, an educator and an assistant (BR-08).
     * @param {object} group
     */
    async #assertGroupReady(group) {
        const missing = [
            !(await this.#rooms.findByGroup(group.id)) && 'a room',
            !group.educatorId && 'an educator',
            !group.assistantId && 'an assistant',
        ].filter(Boolean);
        if (missing.length > 0) {
            throw new HttpError(
                StatusCodes.CONFLICT,
                'GROUP_NOT_READY',
                `The group needs ${missing.join(', ')} before kids join it.`
            );
        }
    }
}

/**
 * @param {object} group
 * @returns {string} Why a kid of another age cannot join the group (BR-02)
 */
function ageMismatch(group) {
    return `The kid must be ${group.age} years old to be in this group.`;
}

/**
 * Financial fields of a kid and their values when a write leaves them out.
 */
const FINANCE_DEFAULTS = Object.freeze({
    discountId: null,
    paymentPlan: 'MONTHLY',
});

/**
 * The discount (BR-26) and the payment plan (FR-013) are financial values:
 * only the admin changes them. The manager may still write a kid, as long as
 * they stay as they are.
 * @param {{ role: string }|undefined} actor
 * @param {object} before The kid before the write
 * @param {object} after Fields of the write; those left out get their
 *   defaults, as the database fills them in for POST and PUT
 * @throws {HttpError} 403 FORBIDDEN
 */
function assertFinanceKept(actor, before, after) {
    if (!actor || actor.role === ROLES.ADMIN) return;
    const changed = Object.entries(FINANCE_DEFAULTS).some(
        ([field, fallback]) =>
            (before[field] ?? fallback) !== (after[field] ?? fallback)
    );
    if (changed) {
        throw forbidden(
            'Only the admin changes the discount and the payment plan of a kid.'
        );
    }
}
