import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/room-repository.js').RoomRepository} RoomRepository
 */

/**
 * Most rooms the kindergarten has (BR-13).
 */
export const MAX_ROOMS = 20;

/**
 * Use cases for rooms. Writes check the business rules on top of what the
 * database checks (schema, references, unique name and group):
 * - there are at most {@link MAX_ROOMS} rooms (BR-13);
 * - a room is either for a group (`groupId`) or for classes of its subjects
 *   (`subjectIds`), not both (BR-14, BR-15). A room with neither is free:
 *   the database leaves it so when its group or last subject is deleted.
 * Each write runs in one transaction, so the checked records cannot change
 * before the write.
 */
export class RoomService {
    #uow;
    #rooms;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {RoomRepository} dependencies.rooms
     */
    constructor({ uow, rooms }) {
        this.#uow = uow;
        this.#rooms = rooms;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#rooms.findPage(query);
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#rooms.findById(id);
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return this.#rooms.getById(id);
    }

    /**
     * @see BaseRepository#create
     * @throws {HttpError} 422 ROOM_PURPOSE_CONFLICT, 409 ROOM_LIMIT_REACHED
     */
    async create(data) {
        return this.#uow.run(async () => {
            this.#assertOnePurpose(data);
            if ((await this.#rooms.count()) >= MAX_ROOMS) {
                throw new HttpError(
                    StatusCodes.CONFLICT,
                    'ROOM_LIMIT_REACHED',
                    `The kindergarten already has ${MAX_ROOMS} rooms.`
                );
            }
            return this.#rooms.create(data);
        });
    }

    /**
     * @see BaseRepository#replace
     * @throws {HttpError} 422 ROOM_PURPOSE_CONFLICT
     */
    async replace(id, data) {
        this.#assertOnePurpose(data);
        return this.#rooms.replace(id, data);
    }

    /**
     * @see BaseRepository#update
     * @throws {HttpError} 422 ROOM_PURPOSE_CONFLICT
     */
    async update(id, changes) {
        return this.#uow.run(async () => {
            const current = await this.#rooms.getById(id);
            this.#assertOnePurpose({ ...current, ...changes });
            return this.#rooms.update(id, changes);
        });
    }

    /** @see BaseRepository#delete */
    async delete(id) {
        return this.#rooms.delete(id);
    }

    /**
     * @param {object} room The room after the write; fields left out get the
     *   defaults of the database (no group, no subjects)
     */
    #assertOnePurpose(room) {
        if (room.groupId && room.subjectIds?.length > 0) {
            throw new HttpError(
                StatusCodes.UNPROCESSABLE_ENTITY,
                'ROOM_PURPOSE_CONFLICT',
                'A room is either for a group or for classes, not both.'
            );
        }
    }
}
