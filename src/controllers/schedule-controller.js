import { StatusCodes } from 'http-status-codes';

/**
 * @typedef {import('../services/schedule-service.js').ScheduleService} ScheduleService
 */

/**
 * HTTP side of timetables (EPIC-05): takes what `validate` checked, calls the
 * service with the account making the request, and chooses the status.
 * Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class ScheduleController {
    #schedules;

    /**
     * @param {object} dependencies
     * @param {ScheduleService} dependencies.schedules
     */
    constructor({ schedules }) {
        this.#schedules = schedules;
    }

    list = async (request, response) => {
        response.json(await this.#schedules.list(request.validated.query));
    };

    generate = async (request, response) => {
        const draft = await this.#schedules.generate();
        response
            .location(`${request.baseUrl}/${draft.id}`)
            .status(StatusCodes.CREATED)
            .json(draft);
    };

    get = async (request, response) => {
        response.json(
            await this.#schedules.get(request.validated.params.id, request.user)
        );
    };

    moveEntry = async (request, response) => {
        const { params, body } = request.validated;
        response.json(
            await this.#schedules.moveEntry(
                params.id,
                params.entryId,
                body,
                request.user
            )
        );
    };

    publish = async (request, response) => {
        response.json(
            await this.#schedules.publish(request.validated.params.id)
        );
    };
}
