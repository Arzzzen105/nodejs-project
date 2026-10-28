import { UnitOfWork } from './repositories/unit-of-work.js';
import { AssistantRepository } from './repositories/assistant-repository.js';
import { DiscountRepository } from './repositories/discount-repository.js';
import { EducatorRepository } from './repositories/educator-repository.js';
import { GroupRepository } from './repositories/group-repository.js';
import { KidRepository } from './repositories/kid-repository.js';
import { NoteRepository } from './repositories/note-repository.js';
import { ParentRepository } from './repositories/parent-repository.js';
import { RoomRepository } from './repositories/room-repository.js';
import { SubjectRepository } from './repositories/subject-repository.js';
import { TeacherRepository } from './repositories/teacher-repository.js';

/**
 * The composition root: the one place that creates the unit of work,
 * repositories (and later services) and wires them through their
 * constructors, as a DI container would. Everything else gets its
 * dependencies passed in and never creates them itself, so tests can build a
 * container over a temporary database.
 *
 * Order matters only in one direction: a part is created after what it
 * depends on (unit of work → repositories → services).
 *
 * @param {import('./storage/file-database.js').FileDatabase} database Created
 *   but not necessarily initialized yet; it is opened by the server
 * @example
 * const container = createContainer(database);
 * await container.repositories.kids.findById(id);
 */
export function createContainer(database) {
    const uow = new UnitOfWork(database);

    const repositories = Object.freeze({
        assistants: new AssistantRepository(uow),
        discounts: new DiscountRepository(uow),
        educators: new EducatorRepository(uow),
        groups: new GroupRepository(uow),
        kids: new KidRepository(uow),
        notes: new NoteRepository(uow),
        parents: new ParentRepository(uow),
        rooms: new RoomRepository(uow),
        subjects: new SubjectRepository(uow),
        teachers: new TeacherRepository(uow),
    });

    // services go here, e.g.
    // const kids = new KidService({ uow, kids: repositories.kids, parents: repositories.parents });

    return Object.freeze({ database, uow, repositories });
}
