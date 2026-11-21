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
import { ConsistencyController } from './controllers/consistency-controller.js';
import { AuthController } from './controllers/auth-controller.js';
import { UserController } from './controllers/user-controller.js';
import { FinanceController } from './controllers/finance-controller.js';
import { ScheduleController } from './controllers/schedule-controller.js';
import { InvoiceController } from './controllers/invoice-controller.js';
import { PaymentController } from './controllers/payment-controller.js';
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
import { UserRepository } from './repositories/user-repository.js';
import { SettingsRepository } from './repositories/settings-repository.js';
import { ScheduleRepository } from './repositories/schedule-repository.js';
import { ScheduleEntryRepository } from './repositories/schedule-entry-repository.js';
import { InvoiceRepository } from './repositories/invoice-repository.js';
import { PaymentRepository } from './repositories/payment-repository.js';
import { AssistantService } from './services/assistant-service.js';
import { AuthService } from './services/auth-service.js';
import { AccessPolicy } from './services/access-policy.js';
import { ConsistencyService } from './services/consistency-service.js';
import { DiscountService } from './services/discount-service.js';
import { EducatorService } from './services/educator-service.js';
import { GroupService } from './services/group-service.js';
import { KidService } from './services/kid-service.js';
import { NoteService } from './services/note-service.js';
import { ParentService } from './services/parent-service.js';
import { RoomService } from './services/room-service.js';
import { SubjectService } from './services/subject-service.js';
import { TeacherService } from './services/teacher-service.js';
import { UserService } from './services/user-service.js';
import { SettingsService } from './services/settings-service.js';
import { FinanceService } from './services/finance-service.js';
import { ScheduleService } from './services/schedule-service.js';
import { InvoiceService } from './services/invoice-service.js';
import { PaymentService } from './services/payment-service.js';
import { PasswordHasher } from './security/password-hasher.js';
import { TokenIssuer } from './security/token-issuer.js';

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
 * @param {object} [options]
 * @param {number} [options.passwordRounds] Cost of password hashing, see
 *   {@link PasswordHasher}; tests lower it to stay fast
 * @param {string} [options.tokenSecret] Key that signs access tokens; needed
 *   only to log in and to check tokens
 * @param {string|number} [options.tokenTtl] Lifetime of a token, see
 *   {@link TokenIssuer}
 * @example
 * const container = createContainer(database);
 * await container.services.kids.get(id);
 */
export function createContainer(
    database,
    { passwordRounds, tokenSecret, tokenTtl } = {}
) {
    const uow = new UnitOfWork(database);
    const passwords = new PasswordHasher({ rounds: passwordRounds });
    const tokens = new TokenIssuer({ secret: tokenSecret, ttl: tokenTtl });

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
        users: new UserRepository(uow),
        settings: new SettingsRepository(uow),
        schedules: new ScheduleRepository(uow),
        // the events of a timetable: managed by the schedule service
        schedule_entries: new ScheduleEntryRepository(uow),
        invoices: new InvoiceRepository(uow),
        payments: new PaymentRepository(uow),
    });

    // which records each user sees, asked by the services that read them
    const access = new AccessPolicy({
        uow,
        groups: repositories.groups,
        kids: repositories.kids,
        schedules: repositories.schedules,
        entries: repositories.schedule_entries,
    });

    // created first: the group service moves kids by its rules (FR-020)
    const kids = new KidService({
        uow,
        kids: repositories.kids,
        parents: repositories.parents,
        groups: repositories.groups,
        rooms: repositories.rooms,
        notes: repositories.notes,
        users: repositories.users,
        access,
    });

    // created before the services of educators and assistants, which return
    // its groups with their derived fields
    const groups = new GroupService({
        uow,
        groups: repositories.groups,
        kids: repositories.kids,
        rooms: repositories.rooms,
        kidService: kids,
        access,
    });

    const settings = new SettingsService({
        uow,
        settings: repositories.settings,
    });

    const services = Object.freeze({
        settings,
        schedules: new ScheduleService({
            uow,
            schedules: repositories.schedules,
            entries: repositories.schedule_entries,
            groups: repositories.groups,
            kids: repositories.kids,
            subjects: repositories.subjects,
            teachers: repositories.teachers,
            rooms: repositories.rooms,
            settings,
            access,
        }),
        // over several collections, so it has no repository of its own
        finance: new FinanceService({
            uow,
            kids: repositories.kids,
            discounts: repositories.discounts,
            settings,
            access,
            groups: repositories.groups,
            rooms: repositories.rooms,
            teachers: repositories.teachers,
            assistants: repositories.assistants,
            users: repositories.users,
            invoices: repositories.invoices,
        }),
        invoices: new InvoiceService({
            uow,
            invoices: repositories.invoices,
            kids: repositories.kids,
            discounts: repositories.discounts,
            settings,
            access,
        }),
        payments: new PaymentService({
            uow,
            payments: repositories.payments,
            invoices: repositories.invoices,
            access,
        }),
        auth: new AuthService({
            uow,
            users: repositories.users,
            passwords,
            tokens,
        }),
        assistants: new AssistantService({
            uow,
            assistants: repositories.assistants,
            groupService: groups,
        }),
        discounts: new DiscountService({
            uow,
            discounts: repositories.discounts,
            kids: repositories.kids,
            access,
        }),
        educators: new EducatorService({
            uow,
            educators: repositories.educators,
            groupService: groups,
            users: repositories.users,
            access,
        }),
        groups,
        kids,
        notes: new NoteService({
            uow,
            notes: repositories.notes,
            kids: repositories.kids,
            access,
        }),
        parents: new ParentService({
            uow,
            parents: repositories.parents,
            kids: repositories.kids,
            users: repositories.users,
            access,
        }),
        rooms: new RoomService({ uow, rooms: repositories.rooms }),
        subjects: new SubjectService({
            uow,
            subjects: repositories.subjects,
            teachers: repositories.teachers,
            rooms: repositories.rooms,
        }),
        teachers: new TeacherService({
            uow,
            teachers: repositories.teachers,
            users: repositories.users,
            access,
        }),
        users: new UserService({
            uow,
            users: repositories.users,
            passwords,
        }),
        // over several collections, so it has no repository of its own
        consistency: new ConsistencyService({
            uow,
            kids: repositories.kids,
            groups: repositories.groups,
            rooms: repositories.rooms,
            educators: repositories.educators,
            assistants: repositories.assistants,
        }),
    });

    const controllers = Object.freeze({
        assistants: new AssistantController({
            assistants: services.assistants,
        }),
        educators: new EducatorController({ educators: services.educators }),
        kids: new KidController({
            kids: services.kids,
            finance: services.finance,
        }),
        parents: new ParentController({ parents: services.parents }),
        groups: new GroupController({
            groups: services.groups,
            schedules: services.schedules,
        }),
        subjects: new SubjectController({ subjects: services.subjects }),
        discounts: new DiscountController({ discounts: services.discounts }),
        teachers: new TeacherController({
            teachers: services.teachers,
            schedules: services.schedules,
        }),
        rooms: new RoomController({
            rooms: services.rooms,
            schedules: services.schedules,
        }),
        notes: new NoteController({ notes: services.notes }),
        auth: new AuthController({ auth: services.auth }),
        users: new UserController({ users: services.users }),
        schedules: new ScheduleController({
            schedules: services.schedules,
        }),
        finance: new FinanceController({
            settings: services.settings,
            finance: services.finance,
        }),
        invoices: new InvoiceController({ invoices: services.invoices }),
        payments: new PaymentController({ payments: services.payments }),
        consistency: new ConsistencyController({
            consistency: services.consistency,
        }),
    });

    return Object.freeze({
        database,
        uow,
        repositories,
        services,
        controllers,
    });
}
