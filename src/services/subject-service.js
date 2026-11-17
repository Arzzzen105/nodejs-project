/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/subject-repository.js').SubjectRepository} SubjectRepository
 * @typedef {import('../repositories/teacher-repository.js').TeacherRepository} TeacherRepository
 * @typedef {import('../repositories/room-repository.js').RoomRepository} RoomRepository
 */

/**
 * Use cases for subjects. CRUD passes the call to the repository as is;
 * related records are read in one transaction with the check that the
 * subject exists.
 */
export class SubjectService {
    #uow;
    #subjects;
    #teachers;
    #rooms;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {SubjectRepository} dependencies.subjects
     * @param {TeacherRepository} dependencies.teachers
     * @param {RoomRepository} dependencies.rooms
     */
    constructor({ uow, subjects, teachers, rooms }) {
        this.#uow = uow;
        this.#subjects = subjects;
        this.#teachers = teachers;
        this.#rooms = rooms;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        return this.#subjects.findPage(query);
    }

    /** @see BaseRepository#findById */
    async find(id) {
        return this.#subjects.findById(id);
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return this.#subjects.getById(id);
    }

    /** @see BaseRepository#create */
    async create(data) {
        return this.#subjects.create(data);
    }

    /** @see BaseRepository#replace */
    async replace(id, data) {
        return this.#subjects.replace(id, data);
    }

    /** @see BaseRepository#update */
    async update(id, changes) {
        return this.#subjects.update(id, changes);
    }

    /** @see BaseRepository#delete */
    async delete(id) {
        return this.#subjects.delete(id);
    }

    /**
     * A page of the teachers who teach the subject.
     * @see TeacherRepository#findPageBySubject
     * @throws {Error} 404 NOT_FOUND if there is no such subject
     */
    async listTeachers(id, query) {
        return this.#uow.run(async () => {
            await this.#subjects.getById(id);
            return this.#teachers.findPageBySubject(id, query);
        });
    }

    /**
     * A page of the rooms for classes of the subject.
     * @see RoomRepository#findPageBySubject
     * @throws {Error} 404 NOT_FOUND if there is no such subject
     */
    async listRooms(id, query) {
        return this.#uow.run(async () => {
            await this.#subjects.getById(id);
            return this.#rooms.findPageBySubject(id, query);
        });
    }
}
