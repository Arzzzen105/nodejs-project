import { BaseRepository } from './base-repository.js';

/**
 * Payments (collection "payments", EPIC-06): money that came in for the
 * invoices of a kid. The invoices of a payment point to it by `paymentId`.
 */
export class PaymentRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'payments');
    }

    /**
     * The payment made by a request with an `Idempotency-Key` (NFR-11).
     * @param {string} operationId The key
     * @returns {Promise<object|null>}
     */
    async findByOperation(operationId) {
        const { items } = await this.findPage({
            where: { operationId },
            limit: 1,
        });
        return items[0] ?? null;
    }
}
