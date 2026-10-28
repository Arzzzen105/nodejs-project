import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/kid-repository.js').KidRepository} KidRepository
 * @typedef {import('../repositories/parent-repository.js').ParentRepository} ParentRepository
 * @typedef {import('../repositories/group-repository.js').GroupRepository} GroupRepository
 * @typedef {import('../repositories/note-repository.js').NoteRepository} NoteRepository
 * @typedef {import('../storage/transaction.js').DeleteReport} DeleteReport
 */

/**
 * Most kids a group may have.
 */
export const MAX_GROUP_SIZE = 20;

/**
 * Use cases for kids. Writes check the business rules on top of what the
 * database checks (schema, references, unique columns):
 * - the mother is FEMALE and the father is MALE;
 * - a kid is of the age of their group;
 * - a group takes at most {@link MAX_GROUP_SIZE} kids.
 * Deleting a kid also deletes what is left without them (FR-018).
 * Each write runs in one transaction, so the checked records cannot change
 * before the write.
 */
export class KidService {
    #uow;
    #kids;
    #parents;
    #groups;
    #notes;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {KidRepository} dependencies.kids
     * @param {ParentRepository} dependencies.parents
     * @param {GroupRepository} dependencies.groups
     * @param {NoteRepository} dependencies.notes
     */
    constructor({ uow, kids, parents, groups, notes }) {
        this.#uow = uow;
        this.#kids = kids;
        this.#parents = parents;
        this.#groups = groups;
        this.#notes = notes;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#kids.findPage(query);
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#kids.findById(id);
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return this.#kids.getById(id);
    }

    /**
     * @see BaseRepository#create
     * @throws {HttpError} 422 MOTHER_NOT_FEMALE, FATHER_NOT_MALE or
     *   GROUP_AGE_MISMATCH, 409 GROUP_FULL
     */
    async create(data) {
        return this.#uow.run(async () => {
            await this.#assertRules({}, data);
            return this.#kids.create(data);
        });
    }

    /**
     * @see BaseRepository#replace
     * @throws {HttpError} As {@link KidService#create}
     */
    async replace(id, data) {
        return this.#uow.run(async () => {
            const current = await this.#kids.getById(id);
            await this.#assertRules(current, data);
            return this.#kids.replace(id, data);
        });
    }

    /**
     * @see BaseRepository#update
     * @throws {HttpError} As {@link KidService#create}
     */
    async update(id, changes) {
        return this.#uow.run(async () => {
            const current = await this.#kids.getById(id);
            await this.#assertRules(current, { ...current, ...changes });
            return this.#kids.update(id, changes);
        });
    }

    /**
     * Deletes a kid by FR-018, all in one transaction: their notes (the
     * database has no cascade), then the kid, then each parent and the group
     * that have no kids left. Educators and assistants stay; rooms lose the
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
                    reports.push(await this.#parents.delete(parentId));
                }
            }
            if (
                kid.groupId &&
                (await this.#kids.countByGroup(kid.groupId)) === 0
            ) {
                reports.push(await this.#groups.delete(kid.groupId));
            }

            return {
                deleted: reports.flatMap((report) => report.deleted),
                updated: reports.flatMap((report) => report.updated),
            };
        });
    }

    /**
     * Checks only what the write changes, so a kid who broke a rule through a
     * change elsewhere (a parent's sex, a group's age) can still be edited.
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

        const joinsGroup = next.groupId !== current.groupId;
        if (next.groupId && (joinsGroup || next.age !== current.age)) {
            await this.#assertGroupFits(next, joinsGroup);
        }
    }

    /**
     * A missing parent is left to the database, which answers 422
     * REFERENCE_NOT_FOUND.
     */
    async #assertParentSex(parentId, sex, code, message) {
        const parent = await this.#parents.findById(parentId);
        if (parent && parent.sex !== sex) {
            throw new HttpError(
                StatusCodes.UNPROCESSABLE_ENTITY,
                code,
                message
            );
        }
    }

    /**
     * A missing group is left to the database, as for parents.
     * @param {object} kid The kid after the write
     * @param {boolean} joins Whether the kid moves into the group: only then
     *   it takes a place
     */
    async #assertGroupFits(kid, joins) {
        const group = await this.#groups.findById(kid.groupId);
        if (!group) return;

        if (group.age !== kid.age) {
            throw new HttpError(
                StatusCodes.UNPROCESSABLE_ENTITY,
                'GROUP_AGE_MISMATCH',
                `The kid must be ${group.age} years old to be in this group.`
            );
        }
        if (
            joins &&
            (await this.#kids.countByGroup(group.id)) >= MAX_GROUP_SIZE
        ) {
            throw new HttpError(
                StatusCodes.CONFLICT,
                'GROUP_FULL',
                `The group already has ${MAX_GROUP_SIZE} kids.`
            );
        }
    }
}
