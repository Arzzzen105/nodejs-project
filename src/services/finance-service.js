import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';
import { ROLES } from '../security/roles.js';
import {
    bestPlan,
    cashIncome,
    cashReport,
    kidPrice,
    planGroups,
    profitReport,
} from './finance-formulas.js';
import { MAX_GROUPS } from './group-service.js';
import { MAX_GROUP_SIZE } from './kid-service.js';
import { monthMoments } from './months.js';

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
 * @typedef {import('../repositories/invoice-repository.js').InvoiceRepository} InvoiceRepository
 * @typedef {import('./access-policy.js').AccessPolicy} AccessPolicy
 */

/**
 * Money of the kindergarten (EPIC-04): what a kid costs, what the
 * kindergarten earns and spends, and what it would with other numbers of
 * kids. Nothing is stored: every answer is counted from the current records,
 * the settings and the paid invoices (EPIC-06), by the formulas of
 * finance-formulas.js.
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
    #invoices;

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
     * @param {InvoiceRepository} dependencies.invoices Paid ones are the
     *   money that came in
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
        invoices,
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
        this.#invoices = invoices;
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
     * Income, expenses and profit for a month (FR-017), by one of two methods:
     * - ACCRUAL (the default): what the kindergarten earns in a month,
     *   counted from the kindergarten as it is now: its kids, groups, staff
     *   and current prices. The annual payment counts as a twelfth. There is
     *   no report of a past month: `asOf` says when it was counted.
     * - CASH: the money that came in within a month in Kyiv: the paid
     *   invoices, by the group of each when issued. A year paid in advance
     *   is income of the month it was paid in. The kindergarten keeps no
     *   records of money spent, so the expenses are those of ACCRUAL, and
     *   the report says so (`expensesBasis`).
     *
     * A kid without a group does not attend, so is not counted.
     * @param {object} [options]
     * @param {'ACCRUAL'|'CASH'} [options.basis='ACCRUAL']
     * @param {string} [options.month] `YYYY-MM`, for CASH only
     * @see profitReport
     * @see cashReport
     */
    async report({ basis = 'ACCRUAL', month } = {}) {
        return this.#uow.run(async () => {
            const settings = await this.#settings.get();
            const accrual = profitReport(
                settings,
                await this.#currentKindergarten()
            );
            if (basis === 'ACCRUAL') {
                return {
                    asOf: new Date().toISOString(),
                    basis,
                    amountsPer: 'MONTH',
                    ...accrual,
                };
            }
            const { from, to } = monthMoments(month);
            const paid = await this.#invoices.findPaidBetween(from, to);
            return {
                asOf: new Date().toISOString(),
                basis,
                month,
                from,
                to,
                expensesBasis: 'ACCRUAL',
                ...cashReport(accrual, cashIncome(paid)),
            };
        });
    }

    /**
     * What the kindergarten would earn and spend in a month with other
     * numbers of kids (2.1 of the requirements), in the most profitable
     * groups they could make (see bestPlan), with the staff and rooms they
     * need, at the current prices. What belongs to no group (managers, teachers, rooms for
     * classes) stays as it is now. Nothing is stored.
     * @param {object} assumptions
     * @param {Record<string, number>} assumptions.kids Kids of each age
     * @param {number} [assumptions.averageDiscount=0]
     * @param {number} [assumptions.annualShare=0]
     * @returns {Promise<object>} The report of the forecast, as
     *   {@link FinanceService#report}, with the total of now to compare
     * @throws {HttpError} 422 TOO_MANY_GROUPS if the kids need more groups
     *   than the kindergarten can have (BR-19)
     */
    async forecast({ kids, averageDiscount = 0, annualShare = 0 }) {
        const assumptions = { averageDiscount, annualShare };
        const fewest = planGroups(kids, {
            groupSize: MAX_GROUP_SIZE,
            ...assumptions,
        });
        if (fewest.length > MAX_GROUPS) {
            throw new HttpError(
                StatusCodes.UNPROCESSABLE_ENTITY,
                'TOO_MANY_GROUPS',
                `These kids need ${fewest.length} groups of at most ${MAX_GROUP_SIZE}; the kindergarten can have at most ${MAX_GROUPS} (BR-19).`
            );
        }
        return this.#uow.run(async () => {
            const settings = await this.#settings.get();
            const current = await this.#currentKindergarten();
            const best = bestPlan(settings, kids, {
                groupSize: MAX_GROUP_SIZE,
                maxGroups: MAX_GROUPS,
                ...assumptions,
            });
            // every planned group has its own assistant
            const planned = (groups) =>
                profitReport(settings, {
                    ...current,
                    groups,
                    assistantsWithoutGroup: 0,
                });
            return {
                asOf: new Date().toISOString(),
                basis: 'ACCRUAL',
                amountsPer: 'MONTH',
                assumptions: { kids, ...assumptions },
                ...planned(best),
                // to compare: the same kids in the fewest groups, shared
                // evenly, and the kindergarten as it is now
                fewestGroups: {
                    groups: fewest.length,
                    total: planned(fewest).total,
                },
                now: profitReport(settings, current).total,
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
