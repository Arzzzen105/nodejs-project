import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';
import { narrow } from './access-policy.js';
import {
    annualInvoiceLines,
    invoiceTotal,
    monthlyInvoiceLines,
} from './finance-formulas.js';
import { monthOf } from './months.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/invoice-repository.js').InvoiceRepository} InvoiceRepository
 * @typedef {import('../repositories/kid-repository.js').KidRepository} KidRepository
 * @typedef {import('../repositories/discount-repository.js').DiscountRepository} DiscountRepository
 * @typedef {import('./settings-service.js').SettingsService} SettingsService
 * @typedef {import('./access-policy.js').AccessPolicy} AccessPolicy
 * @typedef {import('./access-policy.js').Actor} Actor
 */

/**
 * Invoices of the kids (EPIC-06, FR-014): what is owed for a month. What a
 * kid owes for a month:
 * - a MONTHLY invoice: the meals, which are paid monthly (BR-32), and the
 *   tuition of the month, unless an annual invoice already covers it;
 * - on the annual plan, if no annual invoice covers the month yet, an ANNUAL
 *   invoice for the tuition of 12 months from it (FR-013).
 *
 * Lines and amounts are fixed when an invoice is issued: later prices and
 * discounts do not change it. A kid without a group does not attend, so is
 * not invoiced. Paying the invoices is the job of the payment service.
 */
export class InvoiceService {
    #uow;
    #invoices;
    #kids;
    #discounts;
    #settings;
    #access;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {InvoiceRepository} dependencies.invoices
     * @param {KidRepository} dependencies.kids
     * @param {DiscountRepository} dependencies.discounts
     * @param {SettingsService} dependencies.settings Prices of now
     * @param {AccessPolicy} dependencies.access Whose invoices the actor sees
     */
    constructor({ uow, invoices, kids, discounts, settings, access }) {
        this.#uow = uow;
        this.#invoices = invoices;
        this.#kids = kids;
        this.#discounts = discounts;
        this.#settings = settings;
        this.#access = access;
    }

    /**
     * Invoices the actor sees: a parent, those of their kids.
     * @see BaseRepository#findPage
     */
    async list(query = {}, actor) {
        return this.#uow.run(async () =>
            this.#invoices.findPage(
                narrow(query, await this.#access.ownKidScope(actor))
            )
        );
    }

    /**
     * @param {string} id UUIDv7
     * @param {Actor} [actor]
     * @throws {Error} 404 NOT_FOUND if there is no such invoice
     * @throws {HttpError} 403 FORBIDDEN if the kid is not one the actor sees
     */
    async get(id, actor) {
        return this.#uow.run(async () => {
            const invoice = await this.#invoices.getById(id);
            await this.#access.assertKidId(actor, invoice.kidId);
            return invoice;
        });
    }

    /**
     * Issues what a kid owes for a month.
     * @param {string} kidId UUIDv7
     * @param {string} period The month, `YYYY-MM`
     * @returns {Promise<object[]>} The new invoices: the annual one first
     * @throws {Error} 404 NOT_FOUND if there is no such kid
     * @throws {HttpError} 422 KID_NOT_ENROLLED if the kid has no group,
     *   409 INVOICE_EXISTS if the month is already invoiced
     */
    async issue(kidId, period) {
        return this.#uow.run(async () => {
            const kid = await this.#kids.getById(kidId);
            if (!kid.groupId) {
                throw new HttpError(
                    StatusCodes.UNPROCESSABLE_ENTITY,
                    'KID_NOT_ENROLLED',
                    'A kid without a group does not attend the kindergarten, so is not invoiced.'
                );
            }
            const discounts = kid.discountId
                ? [await this.#discounts.getById(kid.discountId)]
                : [];
            const created = await this.#issueFor(
                kid,
                period,
                await this.#settings.get(),
                byId(discounts)
            );
            if (created.length === 0) {
                throw new HttpError(
                    StatusCodes.CONFLICT,
                    'INVOICE_EXISTS',
                    `The kid is already invoiced for ${period}.`
                );
            }
            return created;
        });
    }

    /**
     * Issues what every kid in a group owes for a month, in one transaction.
     * Kids already invoiced for the month are skipped, so it may be repeated.
     * @param {string} period The month, `YYYY-MM`
     * @returns {Promise<{ items: object[], skipped: number }>} The new
     *   invoices, and how many kids were invoiced before
     */
    async issueAll(period) {
        return this.#uow.run(async () => {
            const settings = await this.#settings.get();
            const discounts = byId(await this.#discounts.findEvery());
            const kids = await this.#kids.findAll({
                where: { groupId: { ne: null } },
            });
            const items = [];
            let skipped = 0;
            for (const kid of kids) {
                const created = await this.#issueFor(
                    kid,
                    period,
                    settings,
                    discounts
                );
                if (created.length === 0) skipped++;
                items.push(...created);
            }
            return { items, skipped };
        });
    }

    /**
     * Deletes an invoice that is not paid, e.g. one issued by mistake.
     * @param {string} id UUIDv7
     * @throws {Error} 404 NOT_FOUND if there is no such invoice
     * @throws {HttpError} 409 INVOICE_PAID if it is paid: payments are history
     */
    async delete(id) {
        return this.#uow.run(async () => {
            const invoice = await this.#invoices.getById(id);
            if (invoice.status === 'PAID') {
                throw new HttpError(
                    StatusCodes.CONFLICT,
                    'INVOICE_PAID',
                    'A paid invoice cannot be deleted.'
                );
            }
            return this.#invoices.delete(id);
        });
    }

    /**
     * The invoices a kid owes for a month and does not have yet.
     * @param {object} kid As stored, with a group
     * @param {string} period `YYYY-MM`
     * @param {object} settings
     * @param {Map<string, object>} discounts By id
     * @returns {Promise<object[]>} None if the month is already invoiced
     */
    async #issueFor(kid, period, settings, discounts) {
        const month = monthOf(period, 1);
        if (await this.#invoices.findMonthly(kid.id, month.start)) return [];

        const discount = discounts.get(kid.discountId) ?? null;
        const created = [];
        let tuitionPaid = Boolean(
            await this.#invoices.findAnnualCovering(kid.id, month.start)
        );
        if (kid.paymentPlan === 'ANNUAL' && !tuitionPaid) {
            created.push(
                await this.#create(
                    kid,
                    'ANNUAL',
                    monthOf(period, 12),
                    annualInvoiceLines(settings, discount)
                )
            );
            tuitionPaid = true;
        }
        created.push(
            await this.#create(
                kid,
                'MONTHLY',
                month,
                monthlyInvoiceLines(settings, kid, {
                    discount,
                    tuitionDue: !tuitionPaid,
                })
            )
        );
        return created;
    }

    async #create(kid, kind, { start, end }, lines) {
        return this.#invoices.create({
            kidId: kid.id,
            kidName: `${kid.firstName} ${kid.lastName}`,
            groupId: kid.groupId,
            kind,
            periodStart: start,
            periodEnd: end,
            lines,
            total: invoiceTotal(lines),
        });
    }
}

/** @param {object[]} records */
function byId(records) {
    return new Map(records.map((record) => [record.id, record]));
}
