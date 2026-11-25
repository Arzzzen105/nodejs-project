import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { createTestApp } from '../helpers/test-app.js';
import { createReadyGroup } from '../helpers/ready-group.js';

describe('payments (TS-06.2, FR-014, NFR-11)', () => {
    let app;
    let rawApp;
    let admin;
    let signIn;
    let repositories;
    let close;
    let group;

    beforeEach(async () => {
        let container;
        ({ app, rawApp, admin, signIn, container, close } =
            await createTestApp());
        repositories = container.repositories;
        group = await createReadyGroup(repositories, { age: 3 });
    });

    afterEach(async () => close());

    const createKid = (fields = {}) =>
        repositories.kids.create({
            firstName: 'Marko',
            lastName: 'Koval',
            age: 3,
            sex: 'MALE',
            groupId: group.id,
            ...fields,
        });
    /** Issues the invoices of a kid for a month; the monthly one comes last. */
    const issue = async (kidId, period = '2026-11') => {
        const { body } = await request(app)
            .post('/api/invoices')
            .send({ kidId, period })
            .expect(201);
        return body.items;
    };
    const pay = (invoiceIds, { key, method = 'CARD' } = {}) => {
        const req = request(app).post('/api/payments');
        if (key) req.set('Idempotency-Key', key);
        return req.send({ invoiceIds, method });
    };
    const countPayments = async () =>
        (await repositories.payments.findPage()).total;

    describe('POST /api/payments', () => {
        test('pays an invoice: the sum is counted, the invoice is paid', async () => {
            // ARRANGE
            const kid = await createKid();
            const [invoice] = await issue(kid.id);

            // ACT
            const response = await pay([invoice.id], { method: 'CASH' }).expect(
                201
            );

            // ASSERT
            const payment = response.body;
            expect(response.headers.location).toBe(
                `/api/payments/${payment.id}`
            );
            expect(payment).toMatchObject({
                kidId: kid.id,
                kidName: 'Marko Koval',
                amount: 23800,
                method: 'CASH',
                paidById: admin.id,
                operationId: null,
            });
            expect(Date.parse(payment.paidAt)).not.toBeNaN();
            expect(payment.invoices).toEqual([
                {
                    ...invoice,
                    status: 'PAID',
                    paymentId: payment.id,
                    paidAt: payment.paidAt,
                    updatedAt: expect.any(String),
                },
            ]);
        });

        test('one payment for several months: the sum of them, oldest first', async () => {
            const kid = await createKid();
            const [november] = await issue(kid.id, '2026-11');
            const [december] = await issue(kid.id, '2026-12');

            const { body } = await pay([december.id, november.id]).expect(201);

            expect(body.amount).toBe(23800 * 2);
            expect(body.invoices.map((i) => i.periodStart)).toEqual([
                '2026-11-01',
                '2026-12-01',
            ]);
        });

        test('the annual plan: the year in advance and the meals in one payment', async () => {
            const kid = await createKid({ paymentPlan: 'ANNUAL' });
            const invoices = await issue(kid.id);

            const { body } = await pay(invoices.map((i) => i.id)).expect(201);

            // 15 000 × 0.88 × 12 + 400 × 22
            expect(body.amount).toBe(158400 + 8800);
        });

        test('an invoice named twice is paid once', async () => {
            const kid = await createKid();
            const [invoice] = await issue(kid.id);

            const { body } = await pay([invoice.id, invoice.id]).expect(201);

            expect(body.amount).toBe(23800);
        });

        test('a paid invoice is not paid again: 409 INVOICE_PAID', async () => {
            const kid = await createKid();
            const [paid] = await issue(kid.id, '2026-11');
            const [unpaid] = await issue(kid.id, '2026-12');
            await pay([paid.id]).expect(201);

            const response = await pay([unpaid.id, paid.id]).expect(409);

            expect(response.body.error.code).toBe('INVOICE_PAID');
            expect(await countPayments()).toBe(1);
            expect(
                (await repositories.invoices.getById(unpaid.id)).status
            ).toBe('UNPAID');
        });

        test('the invoices of two kids: 422 INVOICES_OF_DIFFERENT_KIDS', async () => {
            const [marko] = await issue((await createKid()).id);
            const [olia] = await issue(
                (await createKid({ firstName: 'Olia' })).id
            );

            const response = await pay([marko.id, olia.id]).expect(422);

            expect(response.body.error.code).toBe('INVOICES_OF_DIFFERENT_KIDS');
            expect(await countPayments()).toBe(0);
        });

        test('a missing invoice: 404, and nothing is paid (NFR-10)', async () => {
            const kid = await createKid();
            const [invoice] = await issue(kid.id);

            await pay([invoice.id, uuidv7()]).expect(404);

            expect(await countPayments()).toBe(0);
            expect(
                (await repositories.invoices.getById(invoice.id)).status
            ).toBe('UNPAID');
        });

        test.each([
            ['no invoices', { invoiceIds: [], method: 'CARD' }, 'invoiceIds'],
            ['an unknown method', { method: 'CRYPTO' }, 'method'],
            ['a sum of its own', { amount: 1 }, 'amount'],
        ])('answers 422 for %s', async (name, fields, field) => {
            const kid = await createKid();
            const [invoice] = await issue(kid.id);

            const response = await request(app)
                .post('/api/payments')
                .send({ invoiceIds: [invoice.id], method: 'CARD', ...fields })
                .expect(422);

            expect(response.body.error.details.map((d) => d.field)).toEqual([
                field,
            ]);
        });
    });

    describe('Idempotency-Key (NFR-11)', () => {
        let invoice;

        beforeEach(async () => {
            [invoice] = await issue((await createKid()).id);
        });

        test('the same request again answers with the same payment, not a second one', async () => {
            const first = await pay([invoice.id], { key: 'op-1' }).expect(201);

            const again = await pay([invoice.id], { key: 'op-1' }).expect(200);

            expect(again.headers['idempotent-replayed']).toBe('true');
            expect(again.body).toEqual(first.body);
            expect(first.body.operationId).toBe('op-1');
            expect(await countPayments()).toBe(1);
        });

        test('two requests at once make one payment', async () => {
            const responses = await Promise.all([
                pay([invoice.id], { key: 'op-1' }),
                pay([invoice.id], { key: 'op-1' }),
            ]);

            expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
            expect(responses[0].body.id).toBe(responses[1].body.id);
            expect(await countPayments()).toBe(1);
        });

        test('the key used for other invoices: 422 IDEMPOTENCY_KEY_REUSED', async () => {
            await pay([invoice.id], { key: 'op-1' }).expect(201);
            const [other] = await issue(invoice.kidId, '2026-12');

            const response = await pay([other.id], { key: 'op-1' }).expect(422);

            expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
            expect((await repositories.invoices.getById(other.id)).status).toBe(
                'UNPAID'
            );
        });

        test('without a key a repeated request is refused, as the invoice is paid', async () => {
            await pay([invoice.id]).expect(201);

            await pay([invoice.id]).expect(409);

            expect(await countPayments()).toBe(1);
        });

        test('a key longer than 100 characters: 400', async () => {
            const response = await pay([invoice.id], {
                key: 'x'.repeat(101),
            }).expect(400);

            expect(response.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
            expect(await countPayments()).toBe(0);
        });
    });

    describe('GET /api/payments', () => {
        test('the history of a kid, the newest first', async () => {
            const kid = await createKid();
            const other = await createKid({ firstName: 'Olia' });
            const [november] = await issue(kid.id, '2026-11');
            const [december] = await issue(kid.id, '2026-12');
            const [foreign] = await issue(other.id);
            const first = await pay([november.id]).expect(201);
            const second = await pay([december.id]).expect(201);
            await pay([foreign.id]).expect(201);

            const { body } = await request(app)
                .get('/api/payments')
                .query({
                    where: JSON.stringify({ kidId: kid.id }),
                    sort: '-paidAt,-id',
                })
                .expect(200);

            expect(body.items.map((p) => p.id)).toEqual([
                second.body.id,
                first.body.id,
            ]);
        });

        test('a payment comes with the invoices it paid', async () => {
            const kid = await createKid();
            const [invoice] = await issue(kid.id);
            const { body: payment } = await pay([invoice.id]).expect(201);

            const { body } = await request(app)
                .get(`/api/payments/${payment.id}`)
                .expect(200);

            expect(body).toEqual(payment);
        });

        test('answers 404 for a missing payment', async () => {
            await request(app).get(`/api/payments/${uuidv7()}`).expect(404);
        });

        test('a payment cannot be changed or deleted', async () => {
            const kid = await createKid();
            const [invoice] = await issue(kid.id);
            const { body } = await pay([invoice.id]).expect(201);

            await request(app).delete(`/api/payments/${body.id}`).expect(404);
            await request(app)
                .patch(`/api/payments/${body.id}`)
                .send({ amount: 1 })
                .expect(404);
        });
    });

    describe('the parents (2.6, NFR-04)', () => {
        let own;
        let foreign;
        let mom;

        beforeEach(async () => {
            const parent = await repositories.parents.create({
                firstName: 'Olena',
                lastName: 'Koval',
                sex: 'FEMALE',
            });
            [own] = await issue((await createKid({ motherId: parent.id })).id);
            [foreign] = await issue(
                (await createKid({ firstName: 'Olia' })).id
            );
            mom = await signIn({ role: 'PARENT', parentId: parent.id });
        });

        const payAs = (auth, invoiceIds) =>
            request(rawApp)
                .post('/api/payments')
                .set(auth)
                .send({ invoiceIds, method: 'CARD' });

        test('pay the invoices of their kid', async () => {
            const { body } = await payAs(mom.auth, [own.id]).expect(201);

            expect(body).toMatchObject({
                kidId: own.kidId,
                paidById: mom.user.id,
            });
        });

        test('cannot pay for another kid: 403, nothing is paid', async () => {
            await payAs(mom.auth, [foreign.id]).expect(403);

            expect(await countPayments()).toBe(0);
        });

        test('see only the payments of their kids', async () => {
            await payAs(mom.auth, [own.id]).expect(201);
            const { body: other } = await pay([foreign.id]).expect(201);

            const { body } = await request(rawApp)
                .get('/api/payments')
                .set(mom.auth)
                .expect(200);

            expect(body.items.map((p) => p.kidId)).toEqual([own.kidId]);
            await request(rawApp)
                .get(`/api/payments/${other.id}`)
                .set(mom.auth)
                .expect(403);
        });

        test('cannot learn of a payment of another kid by its key', async () => {
            await pay([foreign.id], { key: 'op-1' }).expect(201);

            await request(rawApp)
                .post('/api/payments')
                .set(mom.auth)
                .set('Idempotency-Key', 'op-1')
                .send({ invoiceIds: [foreign.id], method: 'CARD' })
                .expect(403);
        });
    });

    test('deleting the kid keeps the payment, without the kid (FR-018)', async () => {
        const kid = await createKid();
        const [invoice] = await issue(kid.id);
        const { body } = await pay([invoice.id]).expect(201);

        await request(app).delete(`/api/kids/${kid.id}`).expect(204);

        const payment = await request(app)
            .get(`/api/payments/${body.id}`)
            .expect(200);
        expect(payment.body).toMatchObject({
            kidId: null,
            kidName: 'Marko Koval',
            amount: 23800,
        });
        expect(payment.body.invoices[0]).toMatchObject({
            kidId: null,
            status: 'PAID',
        });
    });
});
