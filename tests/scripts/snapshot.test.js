import { describe, beforeAll, afterAll, test, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, TEST_ADMIN } from '../helpers/test-app.js';
import { createClient, seed } from '../../scripts/seed.js';
import { collectSnapshot } from '../../scripts/snapshot.js';
import { esc, renderSnapshot } from '../../scripts/snapshot-html.js';

/** The client of the scripts over a test application, as over HTTP. */
const clientOf = (app) =>
    createClient(async ({ method, path, body, token }) => {
        let call = request(app)[method.toLowerCase()](path);
        if (token) call = call.set('authorization', `Bearer ${token}`);
        const response = await call.send(body);
        return { status: response.status, body: response.body };
    });

const SECTIONS = [
    'overview',
    'groups',
    'kids',
    'parents',
    'staff',
    'subjects',
    'schedule',
    'money',
    'invoices',
    'users',
    'changes',
];

describe('scripts/snapshot.js', () => {
    describe('a whole kindergarten', () => {
        let testApp;
        let data;
        let html;

        beforeAll(async () => {
            testApp = await createTestApp();
            const api = clientOf(testApp.rawApp);
            await api.login(TEST_ADMIN.username, TEST_ADMIN.password);
            await seed(api);
            data = await collectSnapshot(api, {
                now: new Date('2026-11-21T10:00:00Z'),
            });
            html = renderSnapshot({ ...data, server: 'http://test' });
        }, 60000);

        afterAll(async () => testApp?.close());

        test('reads every record through the API', () => {
            expect(data.kids).toHaveLength(190);
            expect(data.groups).toHaveLength(15);
            expect(data.rooms).toHaveLength(20);
            expect(data.schedule.status).toBe('PUBLISHED');
            expect(data.invoices.length).toBeGreaterThan(190);
            expect(data.changes).toHaveLength(50);
        });

        test('has every section, with a link to it', () => {
            for (const id of SECTIONS) {
                expect(html).toContain(`<section id="${id}">`);
                expect(html).toContain(`<a href="#${id}">`);
            }
        });

        test('shows the records by name', () => {
            const kid = data.kids[0];
            const mother = data.parents.find((p) => p.id === kid.motherId);

            expect(html).toContain(esc(`${kid.lastName} ${kid.firstName}`));
            expect(html).toContain(
                esc(`${mother.lastName} ${mother.firstName}`)
            );
            for (const group of data.groups) {
                expect(html).toContain(esc(group.name));
            }
            expect(html).toContain('Діагностика (FR-019): проблем немає.');
        });

        test('the published timetable: a week of each group, events across their slots', () => {
            expect(html).toContain('Опублікований розклад');
            // a table of a week for each group
            expect(html.match(/<table class="week">/g)).toHaveLength(15);
            // a sleep of an hour takes 4 rows of 15 minutes
            expect(html).toContain('<td rowspan="4" class="SLEEP">Сон');
            expect(html).toContain('Сніданок');
        });

        test('money: the profit of the report, and what came in', () => {
            const profit = new Intl.NumberFormat('uk-UA', {
                maximumFractionDigits: 2,
            }).format(data.report.total.profit);

            expect(html).toContain(esc(`${profit} грн`));
            expect(html).toContain(`Отримано за ${data.cash.month}`);
        });

        test('never shows a password, not even its hash', () => {
            expect(html).not.toContain('passwordHash');
            expect(html).not.toMatch(/\$2[aby]\$/);
        });

        test('the page is whole and loads nothing from outside', () => {
            expect(html).toMatch(/^<!doctype html>/);
            expect(html.trim()).toMatch(/<\/html>$/);
            expect(html).not.toMatch(/<script|<link|src=|https?:\/\/(?!test)/);
        });
    });

    test('an empty database: nothing to show, said so', async () => {
        const testApp = await createTestApp();
        try {
            const api = clientOf(testApp.rawApp);
            await api.login(TEST_ADMIN.username, TEST_ADMIN.password);

            const html = renderSnapshot(await collectSnapshot(api));

            expect(html).toContain('Розкладу ще немає');
            expect(html).toContain('Немає записів.');
        } finally {
            await testApp.close();
        }
    });

    describe('renderSnapshot', () => {
        /** The least data a page needs. */
        const minimal = (fields = {}) => ({
            takenAt: '2026-11-21T10:00:00Z',
            kids: [],
            parents: [],
            groups: [],
            educators: [],
            assistants: [],
            teachers: [],
            subjects: [],
            rooms: [],
            discounts: [],
            users: [],
            invoices: [],
            payments: [],
            schedule: null,
            problems: [],
            settings: {},
            report: {
                groups: [],
                shared: {
                    managers: { count: 0, amount: 0 },
                    teachers: { count: 0, amount: 0 },
                    assistantsWithoutGroup: { count: 0, amount: 0 },
                    classRooms: { count: 0, amount: 0 },
                    total: 0,
                },
                total: { income: 0, expenses: 0, profit: 0 },
            },
            cash: {
                month: '2026-11',
                groups: [],
                total: { income: 0, expenses: 0, profit: 0 },
            },
            changes: [],
            ...fields,
        });

        test('a draft is shown when nothing is published, with what it could not place', () => {
            const group = { id: 'g1', name: 'Bees', age: 3 };
            const subject = { id: 's1', name: 'Chess' };

            const html = renderSnapshot(
                minimal({
                    groups: [group],
                    subjects: [{ ...subject, subjectIds: [] }],
                    schedule: {
                        status: 'DRAFT',
                        unplaced: [
                            {
                                groupId: 'g1',
                                subjectId: 's1',
                                missing: 2,
                                reason: 'NO_TEACHER',
                            },
                        ],
                        entries: [],
                    },
                })
            );

            expect(html).toContain('показано <b>чорновик</b>');
            expect(html).toContain('Не вдалося розставити');
            expect(html).toContain('NO_TEACHER');
        });

        test('escapes what comes from the database', () => {
            const html = renderSnapshot(
                minimal({
                    groups: [
                        { id: 'g1', name: '<script>alert(1)</script>', age: 3 },
                    ],
                })
            );

            expect(html).not.toContain('<script>alert(1)</script>');
            expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        });

        test('problems of the diagnostics are listed in words', () => {
            const html = renderSnapshot(
                minimal({
                    problems: [
                        { code: 'KID_WITHOUT_GROUP', entity: 'kids', count: 3 },
                    ],
                })
            );

            expect(html).toContain('Діти без групи');
            expect(html).not.toContain('проблем немає');
        });
    });

    test.each([
        ['<a href="x">', '&lt;a href=&quot;x&quot;&gt;'],
        ["O'Neil & Co", 'O&#39;Neil &amp; Co'],
        [null, ''],
    ])('esc(%j)', (value, escaped) => {
        expect(esc(value)).toBe(escaped);
    });
});
