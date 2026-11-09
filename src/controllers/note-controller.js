import { StatusCodes } from 'http-status-codes';

/**
 * @typedef {import('../services/note-service.js').NoteService} NoteService
 */

/**
 * HTTP side of notes about a kid: takes what `validate` checked, calls the
 * service and chooses the status. The kid comes from the path. Errors are left
 * to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class NoteController {
    #notes;

    /**
     * @param {object} dependencies
     * @param {NoteService} dependencies.notes
     */
    constructor({ notes }) {
        this.#notes = notes;
    }

    list = async (request, response) => {
        const { params, query } = request.validated;
        response.json(await this.#notes.list(params.kidId, query));
    };

    create = async (request, response) => {
        const { params, body } = request.validated;
        const note = await this.#notes.create(params.kidId, body);
        response
            .location(`${request.baseUrl}/${note.id}`)
            .status(StatusCodes.CREATED)
            .json(note);
    };

    get = async (request, response) => {
        const { kidId, id } = request.validated.params;
        response.json(await this.#notes.get(kidId, id));
    };

    replace = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#notes.replace(params.kidId, params.id, body));
    };

    update = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#notes.update(params.kidId, params.id, body));
    };

    delete = async (request, response) => {
        const { kidId, id } = request.validated.params;
        await this.#notes.delete(kidId, id);
        response.status(StatusCodes.NO_CONTENT).end();
    };
}
