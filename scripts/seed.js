// A whole kindergarten for trying the system out: 15 groups, about 190 kids
// with their parents, staff, rooms, subjects, discounts, accounts of every
// role and a published timetable. It goes through the HTTP API as the admin,
// so every business rule applies, and works with any running server:
//
//     npm run dev            # in one terminal
//     npm run seed           # in another
//
// SEED_URL (default http://localhost:3000), ADMIN_USERNAME and ADMIN_PASSWORD
// (default admin / admin-password, as npm run dev creates) can be set in .env.
// The same data come out every time; a database that already has groups is
// left alone.
import { fileURLToPath } from 'node:url';

/** Passwords of the accounts the seed creates: "<username>-password". */
export const ACCOUNTS = Object.freeze({
    manager: 'MANAGER',
    educator: 'EDUCATOR',
    teacher: 'TEACHER',
    parent: 'PARENT',
});

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
 * A client of the API: sends a request with the token of the last login and
 * answers the body, or throws with the error of the API.
 * @param {(request: { method: string, path: string, body?: object, token?: string }) => Promise<{ status: number, body: any }>} send
 */
export function createClient(send) {
    let token;
    const call = async (method, path, body) => {
        const response = await send({ method, path, body, token });
        if (response.status >= 400) {
            const error = response.body?.error;
            throw new Error(
                `${method} ${path}: ${response.status} ${error?.code ?? ''} ${error?.message ?? ''}`.trim()
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
 * @param {object} [options]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<object>} What was created, for the summary
 */
export async function seed(api, { log = () => {} } = {}) {
    if ((await api.get('/api/groups?limit=1')).total > 0) {
        throw new Error(
            'The kindergarten already has groups: seed an empty database (restart npm run dev).'
        );
    }
    const random = seededRandom(2026);
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

    log('15 groups with their educators, assistants and rooms');
    const groups = [];
    for (const [index, name] of GROUP_NAMES.entries()) {
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
        // 12–13 kids a group: the most profitable size by the default
        // settings (docs/analysis/group-size-and-profit.md)
        const size = index < 10 ? 13 : 12;
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
                needsSpeechLessons: random() < 0.07,
                paymentPlan: random() < 0.25 ? 'ANNUAL' : 'MONTHLY',
                discountId:
                    chance < 0.1
                        ? discounts[0].id
                        : chance < 0.16
                          ? discounts[1].id
                          : chance < 0.2
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

    log('The timetable');
    const draft = await api.post('/api/schedules');
    let published = false;
    if (draft.unplaced.length === 0) {
        await api.post(`/api/schedules/${draft.id}/publish`);
        published = true;
    }

    const report = await api.get('/api/finance/report');
    return {
        groups: groups.length,
        kids: kids.length,
        families: families.length,
        withSiblings: families.filter((f) => f.kids.length > 1).length,
        teachers: Object.keys(teachers).length,
        schedule: { id: draft.id, events: draft.placed, published },
        profit: report.total.profit,
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
            log: (m) => console.log(`[seed] ${m}`),
        });
        console.log(
            `[seed] Done in ${((Date.now() - started) / 1000).toFixed(1)} s: ${result.groups} groups, ${result.kids} kids in ${result.families} families (${result.withSiblings} with two kids), ${result.teachers} teachers.`
        );
        console.log(
            `[seed] Timetable: ${result.schedule.events} events, ${result.schedule.published ? 'published' : 'NOT published, see its unplaced lessons'}. Profit a month: ${result.profit}.`
        );
        console.log('[seed] Accounts (password: <username>-password):');
        for (const [username, role] of Object.entries(ACCOUNTS)) {
            console.log(`[seed]   ${username.padEnd(9)} ${role}`);
        }
        console.log(
            `[seed] The parent has ${result.parent.kids.join(' and ')}. Try docs/postman/Kindergarten tour.postman_collection.json.`
        );
    } catch (error) {
        console.error(`[seed] ${error.message}`);
        if (error.cause?.code === 'ECONNREFUSED') {
            console.error(`[seed] Is the server running at ${base}?`);
        }
        process.exitCode = 1;
    }
}
