import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';
import { idempotencyKey } from '../validators/payment-schemas.js';

/**
 * @typedef {import('../services/payment-service.js').PaymentService} PaymentService
 */

/**
 * HTTP side of payments: takes what `validate` checked, calls the service and
 * chooses the status. Errors are left to the error handler of the application.
 *
 * Handlers are arrow functions, so they keep `this` when passed to a router.
 */
export class PaymentController {
    #payments;

    /**
     * @param {object} dependencies
     * @param {PaymentService} dependencies.payments
     */
    constructor({ payments }) {
        this.#payments = payments;
    }

    list = async (request, response) => {
        response.json(
            await this.#payments.list(request.validated.query, request.user)
        );
    };

    get = async (request, response) => {
        response.json(
            await this.#payments.get(request.validated.params.id, request.user)
        );
    };

    /**
     * 201 with the new payment; 200 with the payment made before when the
     * `Idempotency-Key` was used already, marked by `Idempotent-Replayed`.
     */
    create = async (request, response) => {
        const key = idempotencyKey.safeParse(request.get('Idempotency-Key'));
        if (!key.success) {
            throw new HttpError(
                StatusCodes.BAD_REQUEST,
                'INVALID_IDEMPOTENCY_KEY',
                'The Idempotency-Key header must be 1 to 100 characters.'
            );
        }
        const { payment, replayed } = await this.#payments.create(
            request.validated.body,
            request.user,
            key.data
        );
        if (replayed) response.set('Idempotent-Replayed', 'true');
        response
            .location(`${request.baseUrl}/${payment.id}`)
            .status(replayed ? StatusCodes.OK : StatusCodes.CREATED)
            .json(payment);
    };
}
