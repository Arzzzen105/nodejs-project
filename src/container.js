import { UnitOfWork } from './repositories/unit-of-work.js';
import { KidController } from './controllers/kid-controller.js';
import { EducatorController } from './controllers/educator-controller.js';
import { AssistantController } from './controllers/assistant-controller.js';
import { ParentController } from './controllers/parent-controller.js';
import { GroupController } from './controllers/group-controller.js';
import { SubjectController } from './controllers/subject-controller.js';
import { DiscountController } from './controllers/discount-controller.js';
import { TeacherController } from './controllers/teacher-controller.js';
import { RoomController } from './controllers/room-controller.js';
import { NoteController } from './controllers/note-controller.js';
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
import { AssistantService } from './services/assistant-service.js';
import { DiscountService } from './services/discount-service.js';
import { EducatorService } from './services/educator-service.js';
import { GroupService } from './services/group-service.js';
import { KidService } from './services/kid-service.js';
import { NoteService } from './services/note-service.js';
import { ParentService } from './services/parent-service.js';
import { RoomService } from './services/room-service.js';
import { SubjectService } from './services/subject-service.js';
import { TeacherService } from './services/teacher-service.js';

/**
 * The composition root: the one place that creates the unit of work,
 * repositories, services and controllers and wires them through their
 * constructors, as a DI container would. Everything else gets its
 * dependencies passed in and never creates them itself, so tests can build a
 * container over a temporary database.
 *
 * Order matters only in one direction: a part is created after what it
 * depends on (unit of work → repositories → services → controllers).
 *
 * @param {import('./storage/file-database.js').FileDatabase} database Created
 *   but not necessarily initialized yet; it is opened by the server
 * @example
 * const container = createContainer(database);
 * await container.services.kids.get(id);
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

    const services = Object.freeze({
        assistants: new AssistantService({
            assistants: repositories.assistants,
        }),
        discounts: new DiscountService({ discounts: repositories.discounts }),
        educators: new EducatorService({ educators: repositories.educators }),
        groups: new GroupService({ groups: repositories.groups }),
        kids: new KidService({
            uow,
            kids: repositories.kids,
            parents: repositories.parents,
            groups: repositories.groups,
            notes: repositories.notes,
        }),
        notes: new NoteService({
            uow,
            notes: repositories.notes,
            kids: repositories.kids,
        }),
        parents: new ParentService({ parents: repositories.parents }),
        rooms: new RoomService({ uow, rooms: repositories.rooms }),
        subjects: new SubjectService({ subjects: repositories.subjects }),
        teachers: new TeacherService({ teachers: repositories.teachers }),
    });

    const controllers = Object.freeze({
        assistants: new AssistantController({
            assistants: services.assistants,
        }),
        educators: new EducatorController({ educators: services.educators }),
        kids: new KidController({ kids: services.kids }),
        parents: new ParentController({ parents: services.parents }),
        groups: new GroupController({ groups: services.groups }),
        subjects: new SubjectController({ subjects: services.subjects }),
        discounts: new DiscountController({ discounts: services.discounts }),
        teachers: new TeacherController({ teachers: services.teachers }),
        rooms: new RoomController({ rooms: services.rooms }),
        notes: new NoteController({ notes: services.notes }),
    });

    return Object.freeze({
        database,
        uow,
        repositories,
        services,
        controllers,
    });
}
