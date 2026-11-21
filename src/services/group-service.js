import { StatusCodes } from 'http-status-codes';
import { HttpError, forbidden } from '../http-error.js';
import { ROLES } from '../security/roles.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/group-repository.js').GroupRepository} GroupRepository
 * @typedef {import('../repositories/kid-repository.js').KidRepository} KidRepository
 * @typedef {import('../repositories/room-repository.js').RoomRepository} RoomRepository
 * @typedef {import('./kid-service.js').KidService} KidService
 * @typedef {import('./access-policy.js').AccessPolicy} AccessPolicy
 */

/**
 * Most groups the kindergarten can take (BR-19): at least 5 of the rooms
 * are kept for classes.
 */
export const MAX_GROUPS = 15;

/**
 * What a parent (2.6 of the requirements) and a teacher (2.4) see of the kids
 * of a group: a parent their names only, a teacher also their sex and age.
 * Filtering and sorting by other fields would reveal them.
 */
const VISIBLE_KID_FIELDS = {
    PARENT: ['id', 'firstName', 'lastName'],
    TEACHER: ['id', 'firstName', 'lastName', 'sex', 'age'],
};

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
    #access;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {GroupRepository} dependencies.groups
     * @param {KidRepository} dependencies.kids
     * @param {RoomRepository} dependencies.rooms
     * @param {KidService} dependencies.kidService The rules of kids joining
     *   a group live there
     * @param {AccessPolicy} dependencies.access Which records the
     *   actor sees
     */
    constructor({ uow, groups, kids, rooms, kidService, access }) {
        this.#uow = uow;
        this.#groups = groups;
        this.#kids = kids;
        this.#rooms = rooms;
        this.#kidService = kidService;
        this.#access = access;
    }

    /**
     * @see BaseRepository#findPage
     * @param {object} [query] With `attendsSpeechLessons` (true or false) on
     *   top of `where`: the field is not stored, so `where` cannot filter by it
     * @param {import('./access-policy.js').Actor} [actor]
     *   An educator gets their group, a parent the groups of their kids
     */
    async list(query = {}, actor) {
        const { attendsSpeechLessons, ...rest } = query;
        return this.#uow.run(async () => {
            const speech = await this.#kids.findGroupIdsWithSpeechLessons();
            let ids = this.#access.seesAll(actor)
                ? null
                : await this.#access.groupIds(actor);
            if (attendsSpeechLessons !== undefined) {
                ids ??= await this.#groups.findIds();
                ids = ids.filter(
                    (id) => speech.has(id) === attendsSpeechLessons
                );
            }
            const page =
                ids === null
                    ? await this.#groups.findPage(rest)
                    : await this.#groups.findPageAmong(ids, rest);
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

    /**
     * @see BaseRepository#getById
     * @param {string} id UUIDv7
     * @param {import('./access-policy.js').Actor} [actor]
     * @throws {HttpError} 403 FORBIDDEN if the group is not one the actor sees
     */
    async get(id, actor) {
        return this.#uow.run(async () => {
            const group = await this.#groups.getById(id);
            await this.#access.assertGroup(actor, id);
            return this.#describe(group);
        });
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
     * A page of the kids of the group. A parent sees only the names of the
     * kids (2.6 of the requirements), a teacher also their sex and age (2.4);
     * they filter and sort only by what they see.
     * @see KidRepository#findPageByGroup
     * @param {string} id UUIDv7
     * @param {object} [query]
     * @param {import('./access-policy.js').Actor} [actor]
     * @throws {Error} 404 NOT_FOUND if there is no such group
     * @throws {HttpError} 403 FORBIDDEN if the group is not one the actor
     *   sees, or a parent or a teacher filters or sorts by a field they do
     *   not see
     */
    async listKids(id, query, actor) {
        return this.#uow.run(async () => {
            await this.#groups.getById(id);
            await this.#access.assertGroup(actor, id);
            const fields = VISIBLE_KID_FIELDS[actor?.role];
            if (!fields) return this.#kids.findPageByGroup(id, query);
            assertVisibleFields(query, fields, actor.role);
            const page = await this.#kids.findPageByGroup(id, query);
            return {
                ...page,
                items: page.items.map((kid) => pick(kid, fields)),
            };
        });
    }

    /**
     * The room of the group, or null if it has none.
     * @see RoomRepository#findByGroup
     * @param {string} id UUIDv7
     * @param {import('./access-policy.js').Actor} [actor]
     * @throws {Error} 404 NOT_FOUND if there is no such group
     * @throws {HttpError} 403 FORBIDDEN if the group is not one the actor sees
     */
    async getRoom(id, actor) {
        return this.#uow.run(async () => {
            await this.#groups.getById(id);
            await this.#access.assertGroup(actor, id);
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

/**
 * @param {object} kid As stored
 * @param {string[]} fields
 * @returns {object} Only those fields of the kid
 */
function pick(kid, fields) {
    return Object.fromEntries(fields.map((field) => [field, kid[field]]));
}

/**
 * @param {object} [query] As for BaseRepository#findPage
 * @param {string[]} fields What the actor sees
 * @param {string} role For the message
 * @throws {HttpError} 403 FORBIDDEN if `where` or `sort` uses another field
 */
function assertVisibleFields(query = {}, fields, role) {
    const sorts = [query.sort ?? []]
        .flat()
        .flatMap((sort) => sort.split(','))
        .map((field) => field.trim().replace(/^-/, ''));
    const used = [...Object.keys(query.where ?? {}), ...sorts];
    if (used.some((field) => field && !fields.includes(field))) {
        const who = role === ROLES.TEACHER ? 'Teachers' : 'Parents';
        throw forbidden(
            `${who} filter and sort the kids of a group only by ${fields.join(', ')}.`
        );
    }
}
