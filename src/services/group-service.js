import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/group-repository.js').GroupRepository} GroupRepository
 * @typedef {import('../repositories/kid-repository.js').KidRepository} KidRepository
 * @typedef {import('../repositories/room-repository.js').RoomRepository} RoomRepository
 * @typedef {import('./kid-service.js').KidService} KidService
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
 * Every group it returns has the derived `attendsSpeechLessons` (FR-021):
 * true when at least one of its kids needs speech lessons. It is not stored.
 * Each write runs in one transaction, so the checked records cannot change
 * before the write.
 */
export class GroupService {
    #uow;
    #groups;
    #kids;
    #rooms;
    #kidService;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {GroupRepository} dependencies.groups
     * @param {KidRepository} dependencies.kids
     * @param {RoomRepository} dependencies.rooms
     * @param {KidService} dependencies.kidService The rules of kids joining
     *   a group live there
     */
    constructor({ uow, groups, kids, rooms, kidService }) {
        this.#uow = uow;
        this.#groups = groups;
        this.#kids = kids;
        this.#rooms = rooms;
        this.#kidService = kidService;
    }

    /**
     * @see BaseRepository#findPage
     * @param {object} [query] With `attendsSpeechLessons` (true or false) on
     *   top of `where`: the field is not stored, so `where` cannot filter by it
     */
    async list(query = {}) {
        const { attendsSpeechLessons, ...rest } = query;
        return this.#uow.run(async () => {
            const speech = await this.#kids.findGroupIdsWithSpeechLessons();
            let page;
            if (attendsSpeechLessons === undefined) {
                page = await this.#groups.findPage(rest);
            } else {
                const ids = attendsSpeechLessons
                    ? [...speech]
                    : (await this.#groups.findIds()).filter(
                          (id) => !speech.has(id)
                      );
                page = await this.#groups.findPageAmong(ids, rest);
            }
            return {
                ...page,
                items: page.items.map((group) => withSpeech(group, speech)),
            };
        });
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#uow.run(async () =>
            this.#describe(await this.#groups.findById(id))
        );
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return this.#uow.run(async () =>
            this.#describe(await this.#groups.getById(id))
        );
    }

    /**
     * The group of an educator, or null if they have none.
     * @see GroupRepository#findByEducator
     */
    async findByEducator(educatorId) {
        return this.#uow.run(async () =>
            this.#describe(await this.#groups.findByEducator(educatorId))
        );
    }

    /**
     * The group of an assistant, or null if they have none.
     * @see GroupRepository#findByAssistant
     */
    async findByAssistant(assistantId) {
        return this.#uow.run(async () =>
            this.#describe(await this.#groups.findByAssistant(assistantId))
        );
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
            return this.#describe(await this.#groups.create(data));
        });
    }

    /** @see BaseRepository#replace */
    async replace(id, data) {
        return this.#uow.run(async () =>
            this.#describe(await this.#groups.replace(id, data))
        );
    }

    /** @see BaseRepository#update */
    async update(id, changes) {
        return this.#uow.run(async () =>
            this.#describe(await this.#groups.update(id, changes))
        );
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

    /**
     * Moves several kids into the group at once (FR-020).
     * @see KidService#joinGroup
     */
    async addKids(id, kidIds) {
        return this.#kidService.joinGroup(id, kidIds);
    }

    /**
     * @param {object|null} group As stored
     * @returns {Promise<object|null>} The group with its derived fields
     */
    async #describe(group) {
        if (!group) return null;
        return withSpeech(
            group,
            await this.#kids.findGroupIdsWithSpeechLessons()
        );
    }
}

/**
 * @param {object} group As stored
 * @param {Set<string>} speech Ids of the groups attending speech lessons
 * @returns {object} The group with `attendsSpeechLessons` (FR-021)
 */
function withSpeech(group, speech) {
    return { ...group, attendsSpeechLessons: speech.has(group.id) };
}
