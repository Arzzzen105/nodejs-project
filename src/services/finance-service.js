import { ROLES } from '../security/roles.js';
import { kidPrice, profitReport } from './finance-formulas.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/kid-repository.js').KidRepository} KidRepository
 * @typedef {import('../repositories/discount-repository.js').DiscountRepository} DiscountRepository
 * @typedef {import('./settings-service.js').SettingsService} SettingsService
 * @typedef {import('../repositories/group-repository.js').GroupRepository} GroupRepository
 * @typedef {import('../repositories/room-repository.js').RoomRepository} RoomRepository
 * @typedef {import('../repositories/teacher-repository.js').TeacherRepository} TeacherRepository
 * @typedef {import('../repositories/assistant-repository.js').AssistantRepository} AssistantRepository
 * @typedef {import('../repositories/user-repository.js').UserRepository} UserRepository
 * @typedef {import('./access-policy.js').AccessPolicy} AccessPolicy
 */

/**
 * Money of the kindergarten (EPIC-04): what a kid costs, what the
 * kindergarten earns and spends, and what it would with other numbers of
 * kids. Nothing is stored: every answer is counted from the current records
 * and the settings, by the formulas of finance-formulas.js.
 */
export class FinanceService {
    #uow;
    #kids;
    #discounts;
    #settings;
    #access;
    #groups;
    #rooms;
    #teachers;
    #assistants;
    #users;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {KidRepository} dependencies.kids
     * @param {DiscountRepository} dependencies.discounts
     * @param {SettingsService} dependencies.settings
     * @param {AccessPolicy} dependencies.access Which kids the actor sees
     * @param {GroupRepository} dependencies.groups
     * @param {RoomRepository} dependencies.rooms
     * @param {TeacherRepository} dependencies.teachers
     * @param {AssistantRepository} dependencies.assistants
     * @param {UserRepository} dependencies.users The managers are accounts
     */
    constructor({
        uow,
        kids,
        discounts,
        settings,
        access,
        groups,
        rooms,
        teachers,
        assistants,
        users,
    }) {
        this.#uow = uow;
        this.#kids = kids;
        this.#discounts = discounts;
        this.#settings = settings;
        this.#access = access;
        this.#groups = groups;
        this.#rooms = rooms;
        this.#teachers = teachers;
        this.#assistants = assistants;
        this.#users = users;
    }

    /**
     * What a kid costs their parents (FR-012, FR-013), line by line.
     * @param {string} kidId UUIDv7
     * @param {import('./access-policy.js').Actor} [actor]
     * @throws {Error} 404 NOT_FOUND if there is no such kid
     * @throws {HttpError} 403 FORBIDDEN if the kid is not one the actor sees
     */
    async kidPrice(kidId, actor) {
        return this.#uow.run(async () => {
            const kid = await this.#kids.getById(kidId);
            await this.#access.assertKid(actor, kid);
            const discount = kid.discountId
                ? await this.#discounts.getById(kid.discountId)
                : null;
            const settings = await this.#settings.get();
            return {
                kidId,
                ...kidPrice(settings, kid, discount?.rate ?? 0),
            };
        });
    }

    /**
     * Income, expenses and profit for a month (FR-017), by the method of
     * accrual, counted from the kindergarten as it is now: its kids, groups,
     * staff and current prices. The system keeps no past states, so there is
     * no report of a past month: `asOf` says when the report was counted. A
     * kid without a group does not attend, so is not counted.
     * @see profitReport
     */
    async report() {
        return this.#uow.run(async () => {
            const settings = await this.#settings.get();
            return {
                asOf: new Date().toISOString(),
                basis: 'ACCRUAL',
                amountsPer: 'MONTH',
                ...profitReport(settings, await this.#currentKindergarten()),
            };
        });
    }

    /**
     * The kindergarten as it is, in the shape profitReport reads.
     * @returns {Promise<import('./finance-formulas.js').ReportInput>}
     */
    async #currentKindergarten() {
        // one after another: they share the transaction of the report
        const groups = await this.#groups.findEvery();
        const kids = await this.#kids.findEvery();
        const discounts = await this.#discounts.findEvery();
        const rooms = await this.#rooms.findEvery();
        const teachers = await this.#teachers.findEvery();
        const assistants = await this.#assistants.findEvery();
        const rates = new Map(discounts.map((d) => [d.id, d.rate]));
        const busyAssistants = new Set(groups.map((g) => g.assistantId));
        return {
            groups: groups.map((group) => ({
                id: group.id,
                name: group.name,
                age: group.age,
                hasEducator: Boolean(group.educatorId),
                hasAssistant: Boolean(group.assistantId),
                rooms: rooms.filter((room) => room.groupId === group.id).length,
                kids: kids
                    .filter((kid) => kid.groupId === group.id)
                    .map((kid) => ({
                        age: kid.age,
                        paymentPlan: kid.paymentPlan,
                        discountRate: rates.get(kid.discountId) ?? 0,
                    })),
            })),
            managers: await this.#users.countByRole(ROLES.MANAGER),
            teachers: teachers.length,
            assistantsWithoutGroup: assistants.filter(
                (assistant) => !busyAssistants.has(assistant.id)
            ).length,
            classRooms: rooms.filter((room) => !room.groupId).length,
        };
    }
}
