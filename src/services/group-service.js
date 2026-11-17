import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/group-repository.js').GroupRepository} GroupRepository
 * @typedef {import('../repositories/kid-repository.js').KidRepository} KidRepository
 * @typedef {import('../repositories/room-repository.js').RoomRepository} RoomRepository
 */

/**
 * Most groups the kindergarten can take (BR-19): at least 5 of the rooms
 * are kept for classes.
 */
export const MAX_GROUPS = 15;

/**
 * Use cases for groups. Writes check the business rules on top of what the
 * database checks (schema, references, unique name, educator and assistant):
 * - there are at most {@link MAX_GROUPS} groups (BR-19).
 * Each write runs in one transaction, so the checked records cannot change
 * before the write.
 */
export class GroupService {
    #uow;
    #groups;
    #kids;
    #rooms;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {GroupRepository} dependencies.groups
     * @param {KidRepository} dependencies.kids
     * @param {RoomRepository} dependencies.rooms
     */
    constructor({ uow, groups, kids, rooms }) {
        this.#uow = uow;
        this.#groups = groups;
        this.#kids = kids;
        this.#rooms = rooms;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#groups.findPage(query);
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#groups.findById(id);
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return this.#groups.getById(id);
    }

    /**
     * @see BaseRepository#create
     * @throws {HttpError} 409 GROUP_LIMIT_REACHED
     */
    async create(data) {
        return this.#uow.run(async () => {
            if ((await this.#groups.count()) >= MAX_GROUPS) {
                throw new HttpError(
                    StatusCodes.CONFLICT,
                    'GROUP_LIMIT_REACHED',
                    `The kindergarten already has ${MAX_GROUPS} groups.`
                );
            }
            return this.#groups.create(data);
        });
    }

    /** @see BaseRepository#replace */
    async replace(id, data) {
        return this.#groups.replace(id, data);
    }

    /** @see BaseRepository#update */
    async update(id, changes) {
        return this.#groups.update(id, changes);
    }

    /** @see BaseRepository#delete */
    async delete(id) {
        return this.#groups.delete(id);
    }

    /**
     * A page of the kids of the group.
     * @see KidRepository#findPageByGroup
     * @throws {Error} 404 NOT_FOUND if there is no such group
     */
    async listKids(id, query) {
        return this.#uow.run(async () => {
            await this.#groups.getById(id);
            return this.#kids.findPageByGroup(id, query);
        });
    }

    /**
     * The room of the group, or null if it has none.
     * @see RoomRepository#findByGroup
     * @throws {Error} 404 NOT_FOUND if there is no such group
     */
    async getRoom(id) {
        return this.#uow.run(async () => {
            await this.#groups.getById(id);
            return this.#rooms.findByGroup(id);
        });
    }
}
