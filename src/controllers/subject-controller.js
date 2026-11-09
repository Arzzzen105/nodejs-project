import { StatusCodes } from 'http-status-codes';

/**
 * @typedef {import('../services/subject-service.js').SubjectService} SubjectService
 */

/**
 * HTTP side of subjects: takes what `validate` checked, calls the service and
 * chooses the status. Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class SubjectController {
    #subjects;

    /**
     * @param {object} dependencies
     * @param {SubjectService} dependencies.subjects
     */
    constructor({ subjects }) {
        this.#subjects = subjects;
    }

    list = async (request, response) => {
        response.json(await this.#subjects.list(request.validated.query));
    };

    create = async (request, response) => {
        const subject = await this.#subjects.create(request.validated.body);
        response
            .location(`${request.baseUrl}/${subject.id}`)
            .status(StatusCodes.CREATED)
            .json(subject);
    };

    get = async (request, response) => {
        response.json(await this.#subjects.get(request.validated.params.id));
    };

    replace = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#subjects.replace(params.id, body));
    };

    update = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#subjects.update(params.id, body));
    };

    delete = async (request, response) => {
        await this.#subjects.delete(request.validated.params.id);
        response.status(StatusCodes.NO_CONTENT).end();
    };
}
