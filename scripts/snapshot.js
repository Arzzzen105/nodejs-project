// A picture of the database as one HTML page: the kids, groups, staff, the
// timetable, money, accounts and the latest changes. The database is files
// without a client of its own, so this is how its state is shown. It reads
// everything through the HTTP API as the admin, so it works with any running
// server and never touches the files the server holds:
//
//     npm run dev            # in one terminal (npm run seed for data)
//     npm run snapshot       # in another: writes snapshot.html
//
// SNAPSHOT_URL (default http://localhost:3000), SNAPSHOT_FILE (default
// snapshot.html), ADMIN_USERNAME and ADMIN_PASSWORD (default admin /
// admin-password, as npm run dev creates) can be set in .env. The page holds
// personal data: snapshot.html is not in Git.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from './seed.js';
import { renderSnapshot } from './snapshot-html.js';
import { monthAt } from '../src/services/months.js';

/** Collections read whole, by their path. */
const LISTS = {
    kids: '/api/kids?sort=lastName,firstName',
    parents: '/api/parents?sort=lastName,firstName',
    groups: '/api/groups?sort=age,name',
    educators: '/api/educators?sort=lastName,firstName',
    assistants: '/api/assistants?sort=lastName,firstName',
    teachers: '/api/teachers?sort=lastName,firstName',
    subjects: '/api/subjects?sort=name',
    rooms: '/api/rooms?sort=name',
    discounts: '/api/discounts?sort=rate',
    users: '/api/users?sort=username',
    invoices: '/api/invoices?sort=-periodStart,kidName',
    payments: '/api/payments?sort=-paidAt',
};

/**
 * Everything the page shows, read through the API.
 * @param {ReturnType<typeof createClient>} api Logged in as the admin
 * @param {object} [options]
 * @param {Date} [options.now]
 * @returns {Promise<object>} The data of renderSnapshot
 */
export async function collectSnapshot(api, { now = new Date() } = {}) {
    const data = { takenAt: now.toISOString() };
    for (const [name, list] of Object.entries(LISTS)) {
        data[name] = await all(api, list);
    }
    // the published timetable, or the draft while nothing is published
    data.schedule =
        (await optional(api, '/api/schedules/published')) ??
        (await optional(api, '/api/schedules/draft'));
    data.problems = (await api.get('/api/consistency')).problems;
    data.settings = await api.get('/api/finance/settings');
    data.report = await api.get('/api/finance/report');
    const month = monthAt(now);
    data.cash = await api.get(`/api/finance/report?basis=CASH&month=${month}`);
    data.changes = (await api.get('/api/changes?limit=50')).items;
    return data;
}

/** Every page of a list. */
async function all(api, list) {
    const items = [];
    const join = list.includes('?') ? '&' : '?';
    for (let offset = 0; ; offset += 500) {
        const page = await api.get(`${list}${join}limit=500&offset=${offset}`);
        items.push(...page.items);
        if (page.items.length < 500 || items.length >= page.total) {
            return items;
        }
    }
}

/** A record, or null when there is none (404). */
async function optional(api, route) {
    try {
        return await api.get(route);
    } catch (error) {
        if (error.status === 404) return null;
        throw error;
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const base = process.env.SNAPSHOT_URL || 'http://localhost:3000';
    const file = path.resolve(process.env.SNAPSHOT_FILE || 'snapshot.html');
    const api = createClient(async ({ method, path: route, body, token }) => {
        const response = await fetch(base + route, {
            method,
            headers: {
                'content-type': 'application/json',
                ...(token && { authorization: `Bearer ${token}` }),
            },
            body: body && JSON.stringify(body),
        });
        const text = await response.text();
        return {
            status: response.status,
            body: text ? JSON.parse(text) : null,
        };
    });
    try {
        await api.login(
            process.env.ADMIN_USERNAME || 'admin',
            process.env.ADMIN_PASSWORD || 'admin-password'
        );
        const data = await collectSnapshot(api);
        await fs.writeFile(file, renderSnapshot({ ...data, server: base }));
        console.log(
            `[snapshot] ${data.kids.length} kids, ${data.groups.length} groups, timetable: ${data.schedule?.status ?? 'none'}. Open ${file}`
        );
    } catch (error) {
        console.error(`[snapshot] ${error.message}`);
        if (error.cause?.code === 'ECONNREFUSED') {
            console.error(`[snapshot] Is the server running at ${base}?`);
        }
        process.exitCode = 1;
    }
}
