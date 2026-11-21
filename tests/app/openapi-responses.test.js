import { describe, beforeAll, afterAll, test, expect } from 'vitest';
import request from 'supertest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createTestApp, TEST_ADMIN } from '../helpers/test-app.js';
import { createClient, seed } from '../../scripts/seed.js';
import { monthAt } from '../../src/services/months.js';

/**
 * The answers of the API agree with the reference: on a whole kindergarten
 * (npm run seed), every GET of the document, and the writes that answer
 * something of their own, are checked against the schema the reference
 * gives for their status.
 */
describe('the API answers as its reference says (NFR-08)', () => {
    let testApp;
    let document;
    let ajv;
    let ids;
    const auth = () => ({
        authorization: `Bearer ${testApp.adminToken}`,
    });

    beforeAll(async () => {
        testApp = await createTestApp();
        const api = createClient(async ({ method, path, body, token }) => {
            let call = request(testApp.rawApp)[method.toLowerCase()](path);
            if (token) call = call.set('authorization', `Bearer ${token}`);
            const response = await call.send(body);
            return { status: response.status, body: response.body };
        });
        await api.login(TEST_ADMIN.username, TEST_ADMIN.password);
        await seed(api);

        ({ body: document } = await request(testApp.rawApp).get(
            '/api/openapi.json'
        ));
        ajv = new Ajv2020({ strict: false, allErrors: true });
        addFormats(ajv);

        // an id of each kind of record, for the paths
        const first = async (path) =>
            (await api.get(`${path}?limit=1`)).items[0].id;
        const kid = await first('/api/kids');
        ids = {
            kids: kid,
            kidId: kid,
            notes: (
                await api.post(`/api/kids/${kid}/notes`, { text: 'A note' })
            ).id,
            parents: await first('/api/parents'),
            groups: await first('/api/groups'),
            educators: await first('/api/educators'),
            assistants: await first('/api/assistants'),
            teachers: await first('/api/teachers'),
            subjects: await first('/api/subjects'),
            rooms: await first('/api/rooms'),
            discounts: await first('/api/discounts'),
            users: await first('/api/users'),
            invoices: await first('/api/invoices'),
            payments: await first('/api/payments'),
            schedules: await first('/api/schedules'),
        };
    }, 60000);

    afterAll(async () => testApp?.close());

    /**
     * Checks an answer against the schema of its status in the reference.
     * @returns {object} The body
     */
    const agrees = (response, method, path) => {
        const responses = document.paths[path][method].responses;
        const label = `${method.toUpperCase()} ${path} → ${response.status}`;
        expect(Object.keys(responses), label).toContain(
            String(response.status)
        );
        const schema =
            responses[response.status].content?.['application/json']?.schema;
        if (!schema) return response.body;
        // $refs of the schema point into the components of the document
        const validate = ajv.compile({
            ...schema,
            components: document.components,
        });
        const valid = validate(response.body);
        expect(valid ? [] : validate.errors.slice(0, 5), label).toEqual([]);
        return response.body;
    };

    /** `/api/kids/{id}/price` → `/api/kids/<a kid>/price` */
    const fill = (path) =>
        path.replace(
            /\/(\w+)\/\{(\w+)\}/g,
            (match, resource, name) =>
                `/${resource}/${ids[name === 'id' ? resource : name]}`
        );

    test('every GET', async () => {
        let checked = 0;
        for (const [path, methods] of Object.entries(document.paths)) {
            if (!methods.get) continue;
            const response = await request(testApp.rawApp)
                .get(fill(path))
                .set(auth());
            agrees(response, 'get', path);
            checked++;
        }
        expect(checked).toBeGreaterThan(50);
    });

    test('the report by cash, and the forecast', async () => {
        const cash = await request(testApp.rawApp)
            .get('/api/finance/report')
            .query({ basis: 'CASH', month: monthAt() })
            .set(auth());
        const forecast = await request(testApp.rawApp)
            .post('/api/finance/forecast')
            .send({ kids: { 2: 51, 3: 51, 4: 50, 5: 38 } })
            .set(auth());

        expect(cash.status).toBe(200);
        agrees(cash, 'get', '/api/finance/report');
        expect(forecast.status).toBe(200);
        agrees(forecast, 'post', '/api/finance/forecast');
    });

    test('invoicing and paying, repeated with the same key', async () => {
        const kid = (
            await request(testApp.rawApp).post('/api/kids').set(auth()).send({
                firstName: 'Sofia',
                lastName: 'Tour',
                age: 3,
                sex: 'FEMALE',
                paymentPlan: 'ANNUAL',
            })
        ).body;
        const group = (
            await request(testApp.rawApp)
                .get('/api/groups')
                .query({ where: '{"age":3}', limit: 1 })
                .set(auth())
        ).body.items[0];
        await request(testApp.rawApp)
            .patch(`/api/kids/${kid.id}`)
            .set(auth())
            .send({ groupId: group.id })
            .expect(200);

        const issued = await request(testApp.rawApp)
            .post('/api/invoices')
            .set(auth())
            .send({ kidId: kid.id, period: '2030-01' });
        const batch = await request(testApp.rawApp)
            .post('/api/invoices/batch')
            .set(auth())
            .send({ period: '2030-02' });
        const pay = () =>
            request(testApp.rawApp)
                .post('/api/payments')
                .set(auth())
                .set('Idempotency-Key', 'reference-test')
                .send({
                    invoiceIds: issued.body.items.map((i) => i.id),
                    method: 'CASH',
                });
        const paid = await pay();
        const again = await pay();
        const conflict = await request(testApp.rawApp)
            .post('/api/invoices')
            .set(auth())
            .send({ kidId: kid.id, period: '2030-01' });

        expect([
            issued.status,
            batch.status,
            paid.status,
            again.status,
        ]).toEqual([201, 201, 201, 200]);
        agrees(issued, 'post', '/api/invoices');
        agrees(batch, 'post', '/api/invoices/batch');
        agrees(paid, 'post', '/api/payments');
        agrees(again, 'post', '/api/payments');
        agrees(conflict, 'post', '/api/invoices');
    });

    test('the timetable: generate, move, publish', async () => {
        const draft = await request(testApp.rawApp)
            .post('/api/schedules')
            .set(auth());
        const full = await request(testApp.rawApp)
            .get('/api/schedules/draft')
            .set(auth());
        const lesson = full.body.entries.find((e) => e.kind === 'LESSON');
        // the same place: nothing new can conflict
        const moved = await request(testApp.rawApp)
            .patch(`/api/schedules/${draft.body.id}/entries/${lesson.id}`)
            .set(auth())
            .send({ day: lesson.day, slot: lesson.slot });
        const published = await request(testApp.rawApp)
            .post(`/api/schedules/${draft.body.id}/publish`)
            .set(auth());

        expect([draft.status, moved.status, published.status]).toEqual([
            201, 200, 200,
        ]);
        agrees(draft, 'post', '/api/schedules');
        agrees(full, 'get', '/api/schedules/draft');
        agrees(moved, 'patch', '/api/schedules/{id}/entries/{entryId}');
        agrees(published, 'post', '/api/schedules/{id}/publish');
    });

    test('writes of the records answer the records', async () => {
        const created = await request(testApp.rawApp)
            .post('/api/subjects')
            .set(auth())
            .send({ name: 'Drawing' });
        const changed = await request(testApp.rawApp)
            .patch(`/api/subjects/${created.body.id}`)
            .set(auth())
            .send({ lessonsPerWeekAge3: 3 });
        const login = await request(testApp.rawApp)
            .post('/api/auth/login')
            .send(TEST_ADMIN);
        const added = await request(testApp.rawApp)
            .post(`/api/groups/${ids.groups}/kids`)
            .set(auth())
            .send({ kidIds: [] });

        agrees(created, 'post', '/api/subjects');
        agrees(changed, 'patch', '/api/subjects/{id}');
        agrees(login, 'post', '/api/auth/login');
        agrees(added, 'post', '/api/groups/{id}/kids');
    });
});
