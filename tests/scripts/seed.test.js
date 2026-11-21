import { describe, beforeAll, afterAll, test, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, TEST_ADMIN } from '../helpers/test-app.js';
import { createClient, seed } from '../../scripts/seed.js';

describe('scripts/seed.js', () => {
    let testApp;
    let api;
    let result;

    /** The client of the seed over the test application, as over HTTP. */
    const clientOf = (app) =>
        createClient(async ({ method, path, body, token }) => {
            let call = request(app)[method.toLowerCase()](path);
            if (token) call = call.set('authorization', `Bearer ${token}`);
            const response = await call.send(body);
            return { status: response.status, body: response.body };
        });

    beforeAll(async () => {
        testApp = await createTestApp();
        api = clientOf(testApp.rawApp);
        await api.login(TEST_ADMIN.username, TEST_ADMIN.password);
        result = await seed(api);
    }, 60000);

    afterAll(async () => testApp?.close());

    const total = async (path) => (await api.get(`${path}?limit=1`)).total;

    test('a whole kindergarten within the rules', async () => {
        expect(result).toMatchObject({ groups: 15, kids: 190, teachers: 6 });
        // 15 groups (BR-19) and 20 rooms (BR-13)
        expect(await total('/api/groups')).toBe(15);
        expect(await total('/api/rooms')).toBe(20);
        expect(await total('/api/kids')).toBe(190);
        expect(result.withSiblings).toBeGreaterThan(0);
    });

    test('nothing is broken: the diagnostics find no problem', async () => {
        const { problems } = await api.get('/api/consistency');

        expect(problems).toEqual([]);
    });

    test('the timetable is published with every lesson', async () => {
        expect(result.schedule.published).toBe(true);
        const { items } = await api.get('/api/schedules?limit=5');
        expect(items.map((s) => s.status)).toEqual(['PUBLISHED']);
    });

    test('every account logs in and sees its own', async () => {
        const as = clientOf(testApp.rawApp);

        await as.login('educator', 'educator-password');
        expect((await as.get('/api/groups')).total).toBe(1);

        await as.login('parent', 'parent-password');
        expect((await as.get('/api/kids')).total).toBe(2);

        await as.login('teacher', 'teacher-password');
        expect((await as.get('/api/groups')).total).toBe(15);

        await as.login('manager', 'manager-password');
        expect((await as.get('/api/kids')).total).toBe(190);
    });

    test('the report counts the shared expenses of the BA: 570 000', async () => {
        const report = await api.get('/api/finance/report');

        expect(report.shared.total).toBe(570000);
        expect(report.total.profit).toBe(result.profit);
    });

    test('invoices every kid for this month; most are paid, the parent has some to pay', async () => {
        const { month, issued, paid, income } = result.invoices;
        const unpaid = await api.get(
            '/api/invoices?where={"status":"UNPAID"}&limit=500'
        );
        const as = clientOf(testApp.rawApp);
        await as.login('parent', 'parent-password');
        const own = await as.get('/api/invoices');

        // a monthly invoice for each kid, and an annual one on that plan
        const annual = (
            await api.get('/api/kids?where={"paymentPlan":"ANNUAL"}&limit=1')
        ).total;
        expect(issued).toBe(190 + annual);
        expect(paid).toBeGreaterThan(issued / 2);
        expect(paid).toBeLessThan(issued);
        expect(unpaid.total).toBe(issued - paid);
        expect(own.total).toBeGreaterThan(0);
        expect(own.items.every((i) => i.status === 'UNPAID')).toBe(true);
        expect(income).toBeGreaterThan(0);
        expect(month).toMatch(/^\d{4}-\d{2}$/);
    });

    test('refuses a kindergarten that already has groups', async () => {
        await expect(seed(api)).rejects.toThrow(/already has groups/);
    });
});
