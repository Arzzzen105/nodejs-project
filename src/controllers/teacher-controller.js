import { StatusCodes } from 'http-status-codes';

/**
 * @typedef {import('../services/teacher-service.js').TeacherService} TeacherService
 */

/**
 * HTTP side of teachers: takes what `validate` checked, calls the service and
 * chooses the status. Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class TeacherController {
    #teachers;

    /**
     * @param {object} dependencies
     * @param {TeacherService} dependencies.teachers
     */
    constructor({ teachers }) {
        this.#teachers = teachers;
    }

    list = async (request, response) => {
        response.json(await this.#teachers.list(request.validated.query));
    };

    create = async (request, response) => {
        const teacher = await this.#teachers.create(request.validated.body);
        response
            .location(`${request.baseUrl}/${teacher.id}`)
            .status(StatusCodes.CREATED)
            .json(teacher);
    };

    get = async (request, response) => {
        response.json(await this.#teachers.get(request.validated.params.id));
    };

    replace = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#teachers.replace(params.id, body));
    };

    update = async (request, response) => {
        const { params, body } = request.validated;
        response.json(await this.#teachers.update(params.id, body));
    };

    delete = async (request, response) => {
        await this.#teachers.delete(request.validated.params.id);
        response.status(StatusCodes.NO_CONTENT).end();
    };
}
