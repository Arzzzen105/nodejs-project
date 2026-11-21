// A whole kindergarten for trying the system out: by default 15 groups, 190
// kids with their parents, staff, rooms, subjects, discounts, accounts of every
// role, a published timetable and the invoices of this month, most of them
// paid. It goes through the HTTP API as the admin, so every business rule
// applies, and works with any running server:
//
//     npm run dev                                  # in one terminal
//     npm run seed                                 # in another
//     npm run seed -- --groups 8 --kids 120        # a kindergarten of your own
//     npm run seed -- --help                       # every option
//
// SEED_URL (default http://localhost:3000), ADMIN_USERNAME and ADMIN_PASSWORD
// (default admin / admin-password, as npm run dev creates) can be set in .env.
// The same options give the same data every time; a database that already has
// groups is left alone.
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { monthAt } from '../src/services/months.js';

/** Passwords of the accounts the seed creates: "<username>-password". */
export const ACCOUNTS = Object.freeze({
    manager: 'MANAGER',
    educator: 'EDUCATOR',
    teacher: 'TEACHER',
    parent: 'PARENT',
});

/** BR-03 */
const MAX_KIDS_IN_GROUP = 20;

const GROUP_NAMES = [
    'Sunshine',
    'Bees',
    'Stars',
    'Rainbow',
    'Ladybugs',
    'Dolphins',
    'Squirrels',
    'Owls',
    'Butterflies',
    'Bunnies',
    'Hedgehogs',
    'Kittens',
    'Fireflies',
    'Penguins',
    'Foxes',
];
const WOMEN = [
    'Olena',
    'Iryna',
    'Oksana',
    'Nataliia',
    'Tetiana',
    'Yuliia',
    'Kateryna',
    'Mariia',
    'Anna',
    'Sofiia',
    'Daryna',
    'Viktoriia',
    'Alina',
    'Halyna',
];
const MEN = [
    'Andrii',
    'Oleh',
    'Ivan',
    'Taras',
    'Petro',
    'Mykola',
    'Dmytro',
    'Serhii',
    'Bohdan',
    'Yurii',
    'Maksym',
    'Artem',
    'Denys',
    'Roman',
    'Vasyl',
];
const GIRLS = [
    'Zlata',
    'Mila',
    'Eva',
    'Polina',
    'Varvara',
    'Solomiia',
    'Vira',
    'Liza',
    'Nadiia',
    'Yeva',
    'Ulyana',
    'Zoriana',
    'Marta',
    'Diana',
];
const BOYS = [
    'Marko',
    'Matvii',
    'Tymofii',
    'Danylo',
    'Nazar',
    'Yaroslav',
    'Oleksii',
    'Ostap',
    'Ihor',
    'Lev',
    'Bohdan',
    'Mark',
    'Zakhar',
    'Illia',
];
const SURNAMES = [
    'Koval',
    'Shevchuk',
    'Bondar',
    'Tkachenko',
    'Kravets',
    'Melnyk',
    'Boiko',
    'Lysenko',
    'Moroz',
    'Rudenko',
    'Savchuk',
    'Marchenko',
    'Polishchuk',
    'Hnatiuk',
    'Pavlenko',
    'Kuzmenko',
    'Klymenko',
    'Zinchenko',
    'Oliinyk',
    'Tkachuk',
    'Fedoruk',
    'Yatsenko',
    'Kostenko',
    'Levchenko',
];
const SUBJECTS = [
    ['wrestling', 'Wrestling'],
    ['pe', 'Physical education'],
    ['music', 'Music'],
    ['english', 'English'],
    ['chess', 'Chess'],
    ['speech', 'Speech therapist'],
];

/**
 * Options of the seed, with their defaults: the kindergarten of the
 * requirements. `share` options are parts of the kids (or of the families
 * for `paid`), 0–1.
 */
export const SEED_OPTIONS = Object.freeze({
    groups: {
        default: 15,
        help: 'groups, 1–15 (BR-19); ages go 2, 3, 4, 5, 2, …',
    },
    kids: {
        default: 190,
        help: 'kids in all, shared evenly; at most 20 a group (BR-03)',
    },
    annual: { default: 0.25, share: true, help: 'part on the annual plan' },
    discounts: {
        default: 0.2,
        share: true,
        help: 'part with a discount (10%, 20% or 30%)',
    },
    speech: {
        default: 0.07,
        share: true,
        help: 'part needing speech lessons',
    },
    paid: {
        default: 0.7,
        share: true,
        help: 'part of the families that paid this month',
    },
    random: {
        default: 2026,
        help: 'seed of chance: another number, another kindergarten',
    },
    schedule: {
        default: true,
        flag: 'no-schedule',
        help: 'do not generate and publish the timetable',
    },
    invoices: {
        default: true,
        flag: 'no-invoices',
        help: 'do not issue invoices',
    },
});

/**
 * Checks options of the seed and fills in the defaults.
 * @param {object} [given] Some of SEED_OPTIONS
 * @returns {object} Every option
 * @throws {Error} Listing every wrong option, before anything is written
 */
export function seedOptions(given = {}) {
    const options = {};
    for (const [name, option] of Object.entries(SEED_OPTIONS)) {
        options[name] = given[name] ?? option.default;
    }
    const wrong = [];
    for (const name of Object.keys(given)) {
        if (!(name in SEED_OPTIONS)) wrong.push(`unknown option "${name}"`);
    }
    const whole = (name, min, max) => {
        const value = options[name];
        if (!Number.isInteger(value) || value < min || value > max) {
            wrong.push(
                `--${name} must be a whole number from ${min} to ${max}, not ${value}`
            );
        }
    };
    whole('groups', 1, GROUP_NAMES.length);
    if (Number.isInteger(options.groups)) {
        whole('kids', options.groups, options.groups * MAX_KIDS_IN_GROUP);
    }
    whole('random', 0, 2 ** 32 - 1);
    for (const [name, option] of Object.entries(SEED_OPTIONS)) {
        const value = options[name];
        if (
            option.share &&
            !(typeof value === 'number' && value >= 0 && value <= 1)
        ) {
            wrong.push(`--${name} must be a part from 0 to 1, not ${value}`);
        }
        if ('flag' in option && typeof value !== 'boolean') {
            wrong.push(`${name} must be true or false`);
        }
    }
    if (wrong.length > 0) throw new Error(wrong.join('; '));
    return options;
}

/**
 * Options of the seed from the command line: `--kids 120 --no-schedule`.
 * @param {string[]} argv Without node and the script
 * @returns {{ options: object, help: boolean }} Options as given, unchecked
 * @throws {Error} For an unknown option or a value that is not a number
 */
export function parseSeedArgs(argv) {
    const spec = { help: { type: 'boolean', short: 'h' } };
    for (const [name, option] of Object.entries(SEED_OPTIONS)) {
        spec[option.flag ?? name] = {
            type: 'flag' in option ? 'boolean' : 'string',
        };
    }
    const { values } = parseArgs({ args: argv, options: spec, strict: true });
    const options = {};
    for (const [name, option] of Object.entries(SEED_OPTIONS)) {
        const value = values[option.flag ?? name];
        if (value === undefined) continue;
        if ('flag' in option) {
            options[name] = !value;
            continue;
        }
        const number = Number(value);
        if (value.trim() === '' || Number.isNaN(number)) {
            throw new Error(`--${name} must be a number, not "${value}"`);
        }
        options[name] = number;
    }
    return { options, help: Boolean(values.help) };
}

/** What --help prints. */
export function seedHelp() {
    const lines = Object.entries(SEED_OPTIONS).map(([name, option]) => {
        const flag = option.flag ? `--${option.flag}` : `--${name} <n>`;
        const fallback = option.flag ? '' : ` (default ${option.default})`;
        return `  ${flag.padEnd(18)} ${option.help}${fallback}`;
    });
    return [
        'Usage: npm run seed -- [options]',
        '',
        ...lines,
        '',
        'Example: npm run seed -- --groups 8 --kids 120 --annual 0.5',
    ].join('\n');
}

/**
 * A client of the API: sends a request with the token of the last login and
 * answers the body, or throws with the error of the API (with its `status`
 * and `code`). Also used by scripts/snapshot.js.
 * @param {(request: { method: string, path: string, body?: object, token?: string }) => Promise<{ status: number, body: any }>} send
 */
export function createClient(send) {
    let token;
    const call = async (method, path, body) => {
        const response = await send({ method, path, body, token });
        if (response.status >= 400) {
            const error = response.body?.error;
            throw Object.assign(
                new Error(
                    `${method} ${path}: ${response.status} ${error?.code ?? ''} ${error?.message ?? ''}`.trim()
                ),
                { status: response.status, code: error?.code }
            );
        }
        return response.body;
    };
    return {
        get: (path) => call('GET', path),
        post: (path, body) => call('POST', path, body),
        patch: (path, body) => call('PATCH', path, body),
        async login(username, password) {
            token = (
                await call('POST', '/api/auth/login', { username, password })
            ).token;
        },
    };
}

/**
 * Fills an empty kindergarten.
 * @param {ReturnType<typeof createClient>} api Logged in as the admin
 * @param {object} [settings] Options of SEED_OPTIONS, and:
 * @param {(message: string) => void} [settings.log]
 * @returns {Promise<object>} What was created, for the summary
 * @throws {Error} For wrong options, before anything is written
 */
export async function seed(api, { log = () => {}, ...given } = {}) {
    const options = seedOptions(given);
    if ((await api.get('/api/groups?limit=1')).total > 0) {
        throw new Error(
            'The kindergarten already has groups: seed an empty database (restart npm run dev).'
        );
    }
    const random = seededRandom(options.random);
    const pick = (list) => list[Math.floor(random() * list.length)];

    log('Subjects, teachers and rooms for classes');
    const subjects = {};
    const teachers = {};
    for (const [key, name] of SUBJECTS) {
        subjects[key] = await api.post('/api/subjects', {
            name,
            speechLessons: key === 'speech',
        });
        teachers[key] = await api.post('/api/teachers', {
            firstName: pick(random() < 0.7 ? WOMEN : MEN),
            lastName: pick(SURNAMES),
            subjectIds: [subjects[key].id],
        });
    }
    // the gym hosts two subjects (BR-18); 5 rooms for classes leave 15 for
    // groups (BR-13, BR-19)
    await api.post('/api/rooms', {
        name: 'Gym',
        subjectIds: [subjects.pe.id, subjects.wrestling.id],
    });
    for (const key of ['music', 'english', 'chess', 'speech']) {
        await api.post('/api/rooms', {
            name: `${subjects[key].name} room`,
            subjectIds: [subjects[key].id],
        });
    }

    log('Discounts');
    const discounts = [];
    for (const [name, rate] of [
        ['Large family', 0.1],
        ['Single parent', 0.2],
        ['Veteran family', 0.3],
    ]) {
        discounts.push(await api.post('/api/discounts', { name, rate }));
    }

    log(`${options.groups} groups with their educators, assistants and rooms`);
    const groups = [];
    for (const [index, name] of GROUP_NAMES.slice(
        0,
        options.groups
    ).entries()) {
        const educator = await api.post('/api/educators', {
            firstName: pick(WOMEN),
            lastName: pick(SURNAMES),
        });
        const assistant = await api.post('/api/assistants', {
            firstName: pick(WOMEN),
            lastName: pick(SURNAMES),
        });
        const group = await api.post('/api/groups', {
            name,
            // ages 2–5 in turn: 4 groups of 2, 4 of 3, 4 of 4, 3 of 5
            age: 2 + (index % 4),
            educatorId: educator.id,
            assistantId: assistant.id,
        });
        await api.post('/api/rooms', {
            name: `${name} room`,
            groupId: group.id,
        });
        groups.push(group);
    }

    log('Families and kids');
    const families = [];
    const kids = [];
    for (const [index, group] of groups.entries()) {
        // shared evenly, the first groups one more; by default 12–13 kids a
        // group, the most profitable size by the default settings
        // (docs/analysis/group-size-and-profit.md)
        const size =
            Math.floor(options.kids / options.groups) +
            (index < options.kids % options.groups ? 1 : 0);
        for (let n = 0; n < size; n++) {
            // a brother or a sister of a kid of another age (BR-09)
            const siblings = families.filter(
                (f) => f.kids.length === 1 && f.kids[0].age !== group.age
            );
            let family =
                random() < 0.15 && siblings.length > 0 ? pick(siblings) : null;
            if (!family) {
                const surname = pick(SURNAMES);
                family = {
                    surname,
                    mother: await api.post('/api/parents', {
                        firstName: pick(WOMEN),
                        lastName: surname,
                        sex: 'FEMALE',
                        email: `${surname.toLowerCase()}.${families.length + 1}@example.com`,
                        phone: `+38050${String(1000000 + families.length * 7919).slice(-7)}`,
                    }),
                    father: await api.post('/api/parents', {
                        firstName: pick(MEN),
                        lastName: surname,
                        sex: 'MALE',
                    }),
                    kids: [],
                };
                families.push(family);
            }
            const girl = random() < 0.5;
            const chance = random();
            const kid = await api.post('/api/kids', {
                firstName: pick(girl ? GIRLS : BOYS),
                lastName: family.surname,
                age: group.age,
                sex: girl ? 'FEMALE' : 'MALE',
                groupId: group.id,
                motherId: family.mother.id,
                fatherId: family.father.id,
                needsSpeechLessons: random() < options.speech,
                paymentPlan: random() < options.annual ? 'ANNUAL' : 'MONTHLY',
                // of the kids with a discount: half 10%, 30% 20%, 20% 30%
                discountId:
                    chance < options.discounts * 0.5
                        ? discounts[0].id
                        : chance < options.discounts * 0.8
                          ? discounts[1].id
                          : chance < options.discounts
                            ? discounts[2].id
                            : null,
            });
            family.kids.push(kid);
            kids.push(kid);
        }
    }

    log('Accounts of every role');
    const parentFamily =
        families.find((f) => f.kids.length === 2) ?? families[0];
    const links = {
        manager: {},
        educator: { educatorId: groups[0].educatorId },
        teacher: { teacherId: teachers.music.id },
        parent: { parentId: parentFamily.mother.id },
    };
    for (const [username, role] of Object.entries(ACCOUNTS)) {
        await api.post('/api/users', {
            username,
            password: `${username}-password`,
            role,
            ...links[username],
        });
    }
    await api.post(`/api/kids/${parentFamily.kids[0].id}/notes`, {
        text: 'Allergic to nuts',
    });

    let schedule = null;
    if (options.schedule) {
        log('The timetable');
        const draft = await api.post('/api/schedules');
        let published = false;
        if (draft.unplaced.length === 0) {
            await api.post(`/api/schedules/${draft.id}/publish`);
            published = true;
        }
        schedule = {
            id: draft.id,
            events: draft.placed,
            published,
            unplaced: draft.unplaced.length,
        };
    }

    let invoiced = null;
    if (options.invoices) {
        log('Invoices of this month, most of them paid');
        const month = monthAt();
        const { items: invoices } = await api.post('/api/invoices/batch', {
            period: month,
        });
        // the family of the parent account has something left to pay
        const unpaidKids = new Set(parentFamily.kids.map((kid) => kid.id));
        const byKid = new Map();
        for (const invoice of invoices) {
            byKid.set(invoice.kidId, [
                ...(byKid.get(invoice.kidId) ?? []),
                invoice,
            ]);
        }
        let paid = 0;
        for (const [kidId, own] of byKid) {
            if (unpaidKids.has(kidId) || random() >= options.paid) continue;
            await api.post('/api/payments', {
                invoiceIds: own.map((invoice) => invoice.id),
                method: random() < 0.6 ? 'CARD' : 'CASH',
            });
            paid += own.length;
        }
        const cash = await api.get(
            `/api/finance/report?basis=CASH&month=${month}`
        );
        invoiced = {
            month,
            issued: invoices.length,
            paid,
            income: cash.total.income,
        };
    }

    const report = await api.get('/api/finance/report');
    return {
        options,
        groups: groups.length,
        kids: kids.length,
        families: families.length,
        withSiblings: families.filter((f) => f.kids.length > 1).length,
        teachers: Object.keys(teachers).length,
        schedule,
        profit: report.total.profit,
        invoices: invoiced,
        parent: {
            username: 'parent',
            kids: parentFamily.kids.map((k) => `${k.firstName} ${k.lastName}`),
        },
    };
}

/**
 * The same seed gives the same numbers, so every run makes the same
 * kindergarten (mulberry32).
 * @param {number} seedValue
 * @returns {() => number} Numbers in [0, 1)
 */
function seededRandom(seedValue) {
    let state = seedValue >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await main();
}

async function main() {
    let given;
    try {
        const parsed = parseSeedArgs(process.argv.slice(2));
        if (parsed.help) {
            console.log(seedHelp());
            return;
        }
        given = parsed.options;
        // wrong options are refused before the server is even asked
        seedOptions(given);
    } catch (error) {
        console.error(`[seed] ${error.message}`);
        console.error('[seed] See npm run seed -- --help');
        process.exitCode = 1;
        return;
    }

    const base = process.env.SEED_URL || 'http://localhost:3000';
    const api = createClient(async ({ method, path, body, token }) => {
        const response = await fetch(base + path, {
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
        const started = Date.now();
        const result = await seed(api, {
            ...given,
            log: (m) => console.log(`[seed] ${m}`),
        });
        const say = (message) => console.log(`[seed] ${message}`);
        say(
            `Done in ${((Date.now() - started) / 1000).toFixed(1)} s: ${result.groups} groups, ${result.kids} kids in ${result.families} families (${result.withSiblings} with two kids), ${result.teachers} teachers.`
        );
        const { schedule, invoices } = result;
        say(
            schedule
                ? `Timetable: ${schedule.events} events, ${schedule.published ? 'published' : `NOT published: ${schedule.unplaced} lesson(s) found no place, see the draft`}.`
                : 'Timetable: not generated (--no-schedule).'
        );
        say(`Profit a month: ${result.profit}.`);
        say(
            invoices
                ? `Invoices of ${invoices.month}: ${invoices.issued} issued, ${invoices.paid} paid, ${invoices.income} came in.`
                : 'Invoices: not issued (--no-invoices).'
        );
        say('Accounts (password: <username>-password):');
        for (const [username, role] of Object.entries(ACCOUNTS)) {
            say(`  ${username.padEnd(9)} ${role}`);
        }
        say(
            `The parent has ${result.parent.kids.join(' and ')}. Try docs/postman/Kindergarten tour.postman_collection.json.`
        );
    } catch (error) {
        console.error(`[seed] ${error.message}`);
        if (error.cause?.code === 'ECONNREFUSED') {
            console.error(`[seed] Is the server running at ${base}?`);
        }
        process.exitCode = 1;
    }
}
