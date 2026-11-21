import { BaseRepository } from './base-repository.js';

/**
 * Invoices (collection "invoices", EPIC-06): what is owed for a kid for a
 * month, or for the tuition of a year.
 */
export class InvoiceRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'invoices');
    }

    /**
     * The monthly invoice of a kid for a month.
     * @param {string} kidId UUIDv7
     * @param {string} periodStart First day of the month, `YYYY-MM-01`
     * @returns {Promise<object|null>}
     */
    async findMonthly(kidId, periodStart) {
        return this.#first({ kidId, kind: 'MONTHLY', periodStart });
    }

    /**
     * The annual invoice of a kid whose period includes a day: the tuition
     * of that day is already invoiced.
     * @param {string} kidId UUIDv7
     * @param {string} day `YYYY-MM-DD`
     * @returns {Promise<object|null>}
     */
    async findAnnualCovering(kidId, day) {
        return this.#first({
            kidId,
            kind: 'ANNUAL',
            periodStart: { lte: day },
            periodEnd: { gte: day },
        });
    }

    /**
     * The invoices a payment paid for.
     * @param {string} paymentId UUIDv7
     * @returns {Promise<object[]>} Oldest period first
     */
    async findByPayment(paymentId) {
        return this.findAll({ where: { paymentId }, sort: 'periodStart' });
    }

    /**
     * Invoices paid within a time: the money that came in then.
     * @param {string} from ISO 8601 with an offset, included
     * @param {string} to Not included
     * @returns {Promise<object[]>}
     */
    async findPaidBetween(from, to) {
        return this.findAll({ where: { paidAt: { gte: from, lt: to } } });
    }

    async #first(where) {
        const { items } = await this.findPage({ where, limit: 1 });
        return items[0] ?? null;
    }
}
