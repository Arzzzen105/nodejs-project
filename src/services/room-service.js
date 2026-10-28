/**
 * @typedef {import('../repositories/room-repository.js').RoomRepository} RoomRepository
 */

/**
 * Use cases for rooms. For now every method passes the call to the
 * repository as is; business rules of EPIC-02 are added here.
 */
export class RoomService {
    #rooms;

    /**
     * @param {object} dependencies
     * @param {RoomRepository} dependencies.rooms
     */
    constructor({ rooms }) {
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

    /** @see BaseRepository#create */
    async create(data) {
        return this.#rooms.create(data);
    }

    /** @see BaseRepository#replace */
    async replace(id, data) {
        return this.#rooms.replace(id, data);
    }

    /** @see BaseRepository#update */
    async update(id, changes) {
        return this.#rooms.update(id, changes);
    }

    /** @see BaseRepository#delete */
    async delete(id) {
        return this.#rooms.delete(id);
    }
}
