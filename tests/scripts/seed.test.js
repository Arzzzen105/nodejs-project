import { describe, beforeAll, afterAll, test, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, TEST_ADMIN } from '../helpers/test-app.js';
import {
    createClient,
    parseSeedArgs,
    seed,
    seedOptions,
} from '../../scripts/seed.js';

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

describe('options of the seed', () => {
    /** A seed over a new empty application; answers it and its client. */
    const seeded = async (options) => {
        const testApp = await createTestApp();
        const api = createClient(async ({ method, path, body, token }) => {
            let call = request(testApp.rawApp)[method.toLowerCase()](path);
            if (token) call = call.set('authorization', `Bearer ${token}`);
            const response = await call.send(body);
            return { status: response.status, body: response.body };
        });
        await api.login(TEST_ADMIN.username, TEST_ADMIN.password);
        const result = await seed(api, options);
        return { testApp, api, result };
    };
    const count = async (api, path) =>
        (await api.get(`${path}${path.includes('?') ? '&' : '?'}limit=1`))
            .total;

    test('a small kindergarten of its own', async () => {
        const { testApp, api, result } = await seeded({
            groups: 4,
            kids: 30,
            annual: 1,
            discounts: 0,
            speech: 0,
            paid: 1,
            schedule: false,
        });
        try {
            const groups = (await api.get('/api/groups?sort=age')).items;
            const sizes = [];
            for (const group of groups) {
                sizes.push(await count(api, `/api/groups/${group.id}/kids`));
            }

            expect(groups.map((g) => g.age)).toEqual([2, 3, 4, 5]);
            // 30 kids in 4 groups: the first two take one more
            expect(sizes.sort()).toEqual([7, 7, 8, 8]);
            expect(
                await count(api, '/api/kids?where={"paymentPlan":"ANNUAL"}')
            ).toBe(30);
            expect(
                await count(api, '/api/kids?where={"discountId":{"ne":null}}')
            ).toBe(0);
            expect(
                await count(api, '/api/kids?where={"needsSpeechLessons":true}')
            ).toBe(0);
            expect(await count(api, '/api/schedules')).toBe(0);
            expect(result.schedule).toBeNull();
            // every family paid, but the one of the parent account
            const unpaid = await api.get(
                '/api/invoices?where={"status":"UNPAID"}&limit=500'
            );
            expect(
                new Set(unpaid.items.map((i) => i.kidName.split(' ')[1])).size
            ).toBe(1);
            expect((await api.get('/api/consistency')).problems).toEqual([]);
        } finally {
            await testApp.close();
        }
    }, 30000);

    test('without invoices, and another chance gives other kids', async () => {
        const { testApp, api, result } = await seeded({
            groups: 2,
            kids: 10,
            invoices: false,
            random: 7,
        });
        try {
            expect(result.invoices).toBeNull();
            expect(await count(api, '/api/invoices')).toBe(0);
            expect(result.schedule.published).toBe(true);
            expect(result).toMatchObject({ groups: 2, kids: 10 });
            expect(result.options.random).toBe(7);
        } finally {
            await testApp.close();
        }
    }, 30000);

    test('wrong options write nothing', async () => {
        const testApp = await createTestApp();
        try {
            const api = createClient(async ({ method, path, body, token }) => {
                let call = request(testApp.rawApp)[method.toLowerCase()](path);
                if (token) call = call.set('authorization', `Bearer ${token}`);
                const response = await call.send(body);
                return { status: response.status, body: response.body };
            });
            await api.login(TEST_ADMIN.username, TEST_ADMIN.password);

            await expect(seed(api, { kids: 400 })).rejects.toThrow(
                '--kids must be a whole number from 15 to 300, not 400'
            );
            expect(await count(api, '/api/subjects')).toBe(0);
        } finally {
            await testApp.close();
        }
    });

    describe('seedOptions', () => {
        test('the defaults are the kindergarten of the requirements', () => {
            expect(seedOptions()).toEqual({
                groups: 15,
                kids: 190,
                annual: 0.25,
                discounts: 0.2,
                speech: 0.07,
                paid: 0.7,
                random: 2026,
                schedule: true,
                invoices: true,
            });
        });

        test.each([
            [{ groups: 0 }, '--groups must be a whole number from 1 to 15'],
            [{ groups: 16 }, '--groups must be a whole number from 1 to 15'],
            [{ groups: 2.5 }, '--groups must be a whole number'],
            // at most 20 a group (BR-03), at least one
            [
                { groups: 3, kids: 61 },
                '--kids must be a whole number from 3 to 60',
            ],
            [
                { groups: 3, kids: 2 },
                '--kids must be a whole number from 3 to 60',
            ],
            [{ annual: 1.5 }, '--annual must be a part from 0 to 1'],
            [{ paid: -0.1 }, '--paid must be a part from 0 to 1'],
            [{ random: -1 }, '--random must be a whole number'],
            [{ cats: 3 }, 'unknown option "cats"'],
        ])('refuses %j', (given, message) => {
            expect(() => seedOptions(given)).toThrow(message);
        });

        test('lists every wrong option at once', () => {
            expect(() => seedOptions({ groups: 16, annual: 2 })).toThrow(
                /--groups.*; --annual/
            );
        });
    });

    describe('parseSeedArgs', () => {
        test('numbers and flags', () => {
            expect(
                parseSeedArgs([
                    '--kids',
                    '120',
                    '--annual',
                    '0.5',
                    '--no-schedule',
                ])
            ).toEqual({
                options: { kids: 120, annual: 0.5, schedule: false },
                help: false,
            });
        });

        test('nothing given, nothing set: the defaults apply', () => {
            expect(parseSeedArgs([])).toEqual({ options: {}, help: false });
            expect(parseSeedArgs(['--help']).help).toBe(true);
        });

        test.each([
            [['--kids', 'many'], '--kids must be a number, not "many"'],
            [['--cats', '3'], "Unknown option '--cats'"],
        ])('refuses %j', (argv, message) => {
            expect(() => parseSeedArgs(argv)).toThrow(message);
        });
    });
});
