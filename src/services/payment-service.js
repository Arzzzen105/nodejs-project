import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';
import { narrow } from './access-policy.js';
import { money } from './finance-formulas.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/payment-repository.js').PaymentRepository} PaymentRepository
 * @typedef {import('../repositories/invoice-repository.js').InvoiceRepository} InvoiceRepository
 * @typedef {import('./access-policy.js').AccessPolicy} AccessPolicy
 * @typedef {import('./access-policy.js').Actor} Actor
 */

/**
 * Payments (EPIC-06, FR-014): money that came in for the invoices of a kid.
 * There is no payment system behind it: paying is recording the payment. A
 * payment:
 * - pays whole invoices, all of one kid, none paid before;
 * - comes to their sum, counted here, not sent by the client;
 * - is made in one transaction with marking the invoices paid (NFR-10);
 * - is never changed or deleted: it is the history of money.
 *
 * A request with an `Idempotency-Key` makes at most one payment (NFR-11):
 * the same key again answers with the payment it made.
 */
export class PaymentService {
    #uow;
    #payments;
    #invoices;
    #access;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {PaymentRepository} dependencies.payments
     * @param {InvoiceRepository} dependencies.invoices
     * @param {AccessPolicy} dependencies.access Whose payments the actor sees
     */
    constructor({ uow, payments, invoices, access }) {
        this.#uow = uow;
        this.#payments = payments;
        this.#invoices = invoices;
        this.#access = access;
    }

    /**
     * Payments the actor sees: a parent, those of their kids.
     * @see BaseRepository#findPage
     */
    async list(query = {}, actor) {
        return this.#uow.run(async () =>
            this.#payments.findPage(
                narrow(query, await this.#access.ownKidScope(actor))
            )
        );
    }

    /**
     * A payment with the invoices it paid for.
     * @param {string} id UUIDv7
     * @param {Actor} [actor]
     * @throws {Error} 404 NOT_FOUND if there is no such payment
     * @throws {HttpError} 403 FORBIDDEN if the kid is not one the actor sees
     */
    async get(id, actor) {
        return this.#uow.run(async () => {
            const payment = await this.#payments.getById(id);
            await this.#access.assertKidId(actor, payment.kidId);
            return this.#withInvoices(payment);
        });
    }

    /**
     * Pays invoices of a kid.
     * @param {object} data
     * @param {string[]} data.invoiceIds UUIDv7; a repeated id counts once
     * @param {'CARD'|'CASH'} data.method
     * @param {Actor} [actor] Who records it
     * @param {string} [operationId] The `Idempotency-Key` of the request
     * @returns {Promise<{ payment: object, replayed: boolean }>} The payment
     *   with its invoices; `replayed` if the key had made it before
     * @throws {Error} 404 NOT_FOUND if an invoice does not exist
     * @throws {HttpError} 403 FORBIDDEN if the kid is not one the actor sees,
     *   409 INVOICE_PAID, 422 INVOICES_OF_DIFFERENT_KIDS,
     *   422 IDEMPOTENCY_KEY_REUSED if the key paid other invoices
     */
    async create(data, actor, operationId) {
        try {
            return await this.#pay(data, actor, operationId);
        } catch (error) {
            // another request with the key committed first: answer with it
            if (operationId && error.code === 'UNIQUE_VIOLATION') {
                return this.#pay(data, actor, operationId);
            }
            throw error;
        }
    }

    async #pay({ invoiceIds, method }, actor, operationId) {
        return this.#uow.run(async () => {
            const ids = [...new Set(invoiceIds)];
            const previous = operationId
                ? await this.#payments.findByOperation(operationId)
                : null;
            if (previous) return this.#replay(previous, ids, actor);

            const invoices = [];
            for (const id of ids) {
                invoices.push(await this.#invoices.getById(id));
            }
            const kidId = oneKid(invoices);
            await this.#access.assertKidId(actor, kidId);
            const paid = invoices.find((invoice) => invoice.status === 'PAID');
            if (paid) {
                throw new HttpError(
                    StatusCodes.CONFLICT,
                    'INVOICE_PAID',
                    `The invoice ${paid.id} is already paid.`
                );
            }

            const payment = await this.#payments.create({
                kidId,
                kidName: invoices[0].kidName,
                amount: money(
                    invoices.reduce((sum, invoice) => sum + invoice.total, 0)
                ),
                method,
                paidAt: new Date().toISOString(),
                paidById: actor?.id ?? null,
                operationId: operationId ?? null,
            });
            const updated = [];
            for (const invoice of invoices) {
                updated.push(
                    await this.#invoices.update(invoice.id, {
                        status: 'PAID',
                        paymentId: payment.id,
                        paidAt: payment.paidAt,
                    })
                );
            }
            updated.sort((a, b) => a.periodStart.localeCompare(b.periodStart));
            return {
                payment: { ...payment, invoices: updated },
                replayed: false,
            };
        });
    }

    /**
     * The answer to a key used before: the payment it made, if it was for
     * the same invoices. The key belongs to its payment, so its kid is
     * checked as for reading it.
     */
    async #replay(previous, ids, actor) {
        await this.#access.assertKidId(actor, previous.kidId);
        const payment = await this.#withInvoices(previous);
        const paidIds = payment.invoices.map((invoice) => invoice.id).sort();
        if (paidIds.join() !== [...ids].sort().join()) {
            throw new HttpError(
                StatusCodes.UNPROCESSABLE_ENTITY,
                'IDEMPOTENCY_KEY_REUSED',
                'This Idempotency-Key was used to pay other invoices.'
            );
        }
        return { payment, replayed: true };
    }

    async #withInvoices(payment) {
        return {
            ...payment,
            invoices: await this.#invoices.findByPayment(payment.id),
        };
    }
}

/**
 * @param {object[]} invoices At least one
 * @returns {string|null} Their kid
 * @throws {HttpError} 422 INVOICES_OF_DIFFERENT_KIDS
 */
function oneKid(invoices) {
    const kids = new Set(invoices.map((invoice) => invoice.kidId));
    if (kids.size > 1) {
        throw new HttpError(
            StatusCodes.UNPROCESSABLE_ENTITY,
            'INVOICES_OF_DIFFERENT_KIDS',
            'A payment pays the invoices of one kid.'
        );
    }
    return invoices[0].kidId;
}
