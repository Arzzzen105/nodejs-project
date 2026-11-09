import { StatusCodes } from 'http-status-codes';

/**
 * @typedef {import('../services/room-service.js').RoomService} RoomService
 */

/**
 * HTTP side of rooms: takes what `validate` checked, calls the service and
 * chooses the status. Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class RoomController {
    #rooms;

    /**
     * @param {object} dependencies
     * @param {RoomService} dependencies.rooms
     */
    constructor({ rooms }) {
        this.#rooms = rooms;
    }

    list = async (request, response) => {
        response.json(await this.#rooms.list(request.validated.query));
    };

    create = async (request, response) => {
        const room = await this.#rooms.create(request.validated.body);
        response
            .location(`${request.baseUrl}/${room.id}`)
            .status(StatusCodes.CREATED)
            .json(room);
    };

    get = async (request, response) => {
        response.json(await this.#rooms.get(request.validated.params.id));
    };

    replace = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#rooms.replace(params.id, body));
    };

    update = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#rooms.update(params.id, body));
    };

    delete = async (request, response) => {
        await this.#rooms.delete(request.validated.params.id);
        response.status(StatusCodes.NO_CONTENT).end();
    };
}
