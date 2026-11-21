// The page of npm run snapshot: a pure function from the data collected by
// scripts/snapshot.js to one self-contained HTML document, with no scripts
// and nothing loaded from outside. Every value from the database is escaped.

const TIME_ZONE = 'Europe/Kyiv';
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
const DAY_NAMES = {
    MON: 'Понеділок',
    TUE: 'Вівторок',
    WED: 'Середа',
    THU: 'Четвер',
    FRI: "П'ятниця",
};
const MEALS = { BREAKFAST: 'Сніданок', LUNCH: 'Обід', SNACK: 'Полуденок' };
const SLOTS = 32;

const SECTIONS = [
    ['overview', 'Огляд'],
    ['groups', 'Групи'],
    ['kids', 'Діти'],
    ['parents', 'Батьки'],
    ['staff', 'Персонал'],
    ['subjects', 'Предмети й кімнати'],
    ['schedule', 'Розклад'],
    ['money', 'Гроші'],
    ['invoices', 'Рахунки й платежі'],
    ['users', 'Облікові записи'],
    ['changes', 'Історія змін'],
];

const SETTINGS = {
    tuitionPerMonth: 'Навчання на місяць',
    annualDiscount: 'Знижка за річну оплату',
    workdaysPerMonth: 'Робочих днів на місяць',
    mealPriceAge2: 'Харчування для батьків, 2 роки, за день',
    mealPriceAge3: 'Харчування для батьків, 3 роки, за день',
    mealPriceAge4: 'Харчування для батьків, 4 роки, за день',
    mealPriceAge5: 'Харчування для батьків, 5 років, за день',
    mealCostAge2: 'Закупівля харчування, 2 роки, за день',
    mealCostAge3: 'Закупівля харчування, 3 роки, за день',
    mealCostAge4: 'Закупівля харчування, 4 роки, за день',
    mealCostAge5: 'Закупівля харчування, 5 років, за день',
    managerSalary: 'Зарплата менеджера',
    teacherSalary: 'Зарплата викладача',
    assistantBaseSalary: 'Базова зарплата помічника',
    assistantBonusPerExtraKid: 'Доплата помічнику за дитину понад поріг',
    educatorPayPerKid: 'Ставка вихователя за дитину',
    educatorBonusPerExtraKid: 'Доплата вихователю за дитину понад поріг',
    extraKidsThreshold: 'Поріг дітей для доплат',
    roomCostPerMonth: 'Вартість приміщення на місяць',
    lessonMinutes: 'Тривалість заняття, хв',
};

const PROBLEMS = {
    KID_WITHOUT_GROUP: 'Діти без групи',
    KID_INCOMPLETE_PARENTS: 'Діти без матері чи батька',
    KID_GROUP_AGE_MISMATCH: 'Діти не за віком групи',
    GROUP_WITHOUT_EDUCATOR: 'Групи без вихователя',
    GROUP_WITHOUT_ASSISTANT: 'Групи без помічника',
    GROUP_WITHOUT_ROOM: 'Групи без кімнати',
    GROUP_NOT_READY_WITH_KIDS:
        'Групи з дітьми без кімнати, вихователя чи помічника',
    EDUCATOR_WITHOUT_GROUP: 'Вихователі без групи',
    ASSISTANT_WITHOUT_GROUP: 'Помічники без групи',
};

const ROLES = {
    ADMIN: 'дід',
    MANAGER: 'менеджер',
    EDUCATOR: 'вихователь',
    TEACHER: 'викладач',
    PARENT: 'батьки',
};

/**
 * @param {object} data What scripts/snapshot.js collects, and `server`
 * @returns {string} The whole HTML document
 */
export function renderSnapshot(data) {
    const view = indexes(data);
    const body = [
        overview(view),
        groupsSection(view),
        kidsSection(view),
        parentsSection(view),
        staffSection(view),
        subjectsSection(view),
        scheduleSection(view),
        moneySection(view),
        invoicesSection(view),
        usersSection(view),
        changesSection(view),
    ].join('\n');
    return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Стан садка</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>Стан садка</h1>
<p class="muted">Знімок від ${esc(dateTime(data.takenAt))}${data.server ? `, сервер ${esc(data.server)}` : ''}.</p>
<nav>${SECTIONS.map(([id, title]) => `<a href="#${id}">${esc(title)}</a>`).join('')}</nav>
</header>
<main>
${body}
</main>
</body>
</html>
`;
}

/** The data with maps by id, to name what records point to. */
function indexes(data) {
    const byId = (list) => new Map((list ?? []).map((r) => [r.id, r]));
    return {
        ...data,
        kidsById: byId(data.kids),
        parentsById: byId(data.parents),
        groupsById: byId(data.groups),
        educatorsById: byId(data.educators),
        assistantsById: byId(data.assistants),
        teachersById: byId(data.teachers),
        subjectsById: byId(data.subjects),
        roomsById: byId(data.rooms),
        discountsById: byId(data.discounts),
        usersById: byId(data.users),
    };
}

// ---- sections ---------------------------------------------------------------

function overview(v) {
    const counts = [
        ['Діти', v.kids.length],
        ['Групи', v.groups.length],
        ['Батьки', v.parents.length],
        ['Вихователі', v.educators.length],
        ['Помічники', v.assistants.length],
        ['Викладачі', v.teachers.length],
        ['Предмети', v.subjects.length],
        ['Кімнати', v.rooms.length],
        ['Пільги', v.discounts.length],
        ['Облікові записи', v.users.length],
        ['Рахунки', v.invoices.length],
        ['Платежі', v.payments.length],
    ];
    const total = v.report.total;
    const problems = v.problems.length
        ? table(
              ['Проблема', 'Записів'],
              v.problems.map((p) => [
                  esc(PROBLEMS[p.code] ?? p.code),
                  num(p.count),
              ])
          )
        : '<p class="ok">Діагностика (FR-019): проблем немає.</p>';
    return section(
        'overview',
        'Огляд',
        `<div class="tiles">${counts
            .map(
                ([label, count]) =>
                    `<div class="tile"><div class="value">${num(count)}</div><div class="label">${esc(label)}</div></div>`
            )
            .join('')}</div>
<div class="tiles">
<div class="tile"><div class="value">${money(total.income)}</div><div class="label">Дохід за місяць</div></div>
<div class="tile"><div class="value">${money(total.expenses)}</div><div class="label">Витрати за місяць</div></div>
<div class="tile"><div class="value ${total.profit < 0 ? 'bad' : ''}">${money(total.profit)}</div><div class="label">Прибуток за місяць</div></div>
<div class="tile"><div class="value text">${esc(scheduleState(v.schedule))}</div><div class="label">Розклад</div></div>
</div>
${problems}`
    );
}

function groupsSection(v) {
    const rows = v.groups.map((g) => {
        const kids = v.kids.filter((k) => k.groupId === g.id).length;
        const room = v.rooms.find((r) => r.groupId === g.id);
        return [
            esc(g.name),
            num(g.age),
            person(v.educatorsById.get(g.educatorId)),
            person(v.assistantsById.get(g.assistantId)),
            room ? esc(room.name) : missing(),
            `${num(kids)} / 20`,
            g.attendsSpeechLessons ? 'так' : '',
        ];
    });
    return section(
        'groups',
        'Групи',
        table(
            [
                'Назва',
                'Вік',
                'Вихователь',
                'Помічник',
                'Кімната',
                'Дітей',
                'Логопед',
            ],
            rows
        )
    );
}

function kidsSection(v) {
    const kidRows = (kids) =>
        kids.map((k) => [
            esc(`${k.lastName} ${k.firstName}`),
            num(k.age),
            k.sex === 'FEMALE' ? 'дівчинка' : 'хлопчик',
            person(v.parentsById.get(k.motherId)),
            person(v.parentsById.get(k.fatherId)),
            discount(v.discountsById.get(k.discountId)),
            k.paymentPlan === 'ANNUAL' ? 'річний' : 'щомісячний',
            k.needsSpeechLessons ? 'так' : '',
        ]);
    const headers = [
        'Дитина',
        'Вік',
        'Стать',
        'Мати',
        'Батько',
        'Пільга',
        'План оплати',
        'Логопед',
    ];
    const parts = v.groups.map((g) => {
        const kids = v.kids.filter((k) => k.groupId === g.id);
        return details(
            `${esc(g.name)} <span class="muted">${num(g.age)} р., ${num(kids.length)} дітей</span>`,
            table(headers, kidRows(kids))
        );
    });
    const lonely = v.kids.filter((k) => !k.groupId);
    if (lonely.length) {
        parts.push(
            details(
                `Без групи <span class="muted">${num(lonely.length)}</span>`,
                table(headers, kidRows(lonely))
            )
        );
    }
    return section('kids', 'Діти', parts.join('\n'));
}

function parentsSection(v) {
    const rows = v.parents.map((p) => [
        esc(`${p.lastName} ${p.firstName}`),
        p.sex === 'FEMALE' ? 'жін.' : 'чол.',
        esc(p.phone ?? ''),
        esc(p.email ?? ''),
        esc(p.workplace ?? ''),
        v.kids
            .filter((k) => k.motherId === p.id || k.fatherId === p.id)
            .map((k) => esc(k.firstName))
            .join(', '),
    ]);
    return section(
        'parents',
        'Батьки',
        details(
            `Усі батьки <span class="muted">${num(rows.length)}</span>`,
            table(["Ім'я", 'Стать', 'Телефон', 'Email', 'Робота', 'Діти'], rows)
        )
    );
}

function staffSection(v) {
    const groupOf = (field, id) => v.groups.find((g) => g[field] === id)?.name;
    const workers = (list, field) =>
        table(
            ["Ім'я", 'Група'],
            list.map((w) => [
                esc(`${w.lastName} ${w.firstName}`),
                groupOf(field, w.id) ? esc(groupOf(field, w.id)) : missing(),
            ])
        );
    const teachers = table(
        ["Ім'я", 'Предмети'],
        v.teachers.map((t) => [
            esc(`${t.lastName} ${t.firstName}`),
            t.subjectIds
                .map((id) => esc(v.subjectsById.get(id)?.name ?? '?'))
                .join(', '),
        ])
    );
    return section(
        'staff',
        'Персонал',
        `<div class="columns">
<div><h3>Вихователі</h3>${workers(v.educators, 'educatorId')}</div>
<div><h3>Помічники</h3>${workers(v.assistants, 'assistantId')}</div>
<div><h3>Викладачі</h3>${teachers}</div>
</div>`
    );
}

function subjectsSection(v) {
    const subjects = table(
        ['Предмет', '2 роки', '3 роки', '4 роки', '5 років', 'Викладачі'],
        v.subjects.map((s) => [
            esc(s.name) +
                (s.speechLessons ? ' <span class="tag">логопед</span>' : ''),
            num(s.lessonsPerWeekAge2),
            num(s.lessonsPerWeekAge3),
            num(s.lessonsPerWeekAge4),
            num(s.lessonsPerWeekAge5),
            v.teachers
                .filter((t) => t.subjectIds.includes(s.id))
                .map((t) => esc(t.lastName))
                .join(', ') || missing(),
        ])
    );
    const rooms = table(
        ['Кімната', 'Призначення'],
        v.rooms.map((r) => [
            esc(r.name),
            r.groupId
                ? `група ${esc(v.groupsById.get(r.groupId)?.name ?? '?')}`
                : r.subjectIds.length
                  ? `заняття: ${r.subjectIds.map((id) => esc(v.subjectsById.get(id)?.name ?? '?')).join(', ')}`
                  : '<span class="muted">вільна</span>',
        ])
    );
    const discounts = table(
        ['Пільга', 'Розмір', 'Дітей'],
        v.discounts.map((d) => [
            esc(d.name),
            percent(d.rate),
            num(v.kids.filter((k) => k.discountId === d.id).length),
        ])
    );
    return section(
        'subjects',
        'Предмети й кімнати',
        `<p class="muted">Занять на тиждень для групи кожного віку (BR-54, BR-60).</p>
${subjects}
<div class="columns">
<div><h3>Кімнати (${num(v.rooms.length)} із 20)</h3>${rooms}</div>
<div><h3>Пільги</h3>${discounts}</div>
</div>`
    );
}

function scheduleSection(v) {
    const schedule = v.schedule;
    if (!schedule) {
        return section(
            'schedule',
            'Розклад',
            '<p class="muted">Розкладу ще немає: ні опублікованого, ні чорновика.</p>'
        );
    }
    const head =
        schedule.status === 'PUBLISHED'
            ? `<p>Опублікований розклад, ${esc(dateTime(schedule.publishedAt))}.</p>`
            : '<p class="warn">Опублікованого розкладу немає: показано <b>чорновик</b>.</p>';
    const unplaced = schedule.unplaced?.length
        ? `<h3>Не вдалося розставити</h3>${table(
              ['Група', 'Предмет', 'Занять', 'Причина'],
              schedule.unplaced.map((u) => [
                  esc(v.groupsById.get(u.groupId)?.name ?? '?'),
                  esc(v.subjectsById.get(u.subjectId)?.name ?? '?'),
                  num(u.missing),
                  esc(u.reason),
              ])
          )}`
        : '';
    const legend = `<p class="legend"><span class="LESSON">заняття</span><span class="MEAL">їжа</span><span class="SLEEP">сон</span><span>вільний час</span></p>`;
    const grids = v.groups.map((g) =>
        details(
            esc(g.name) + ` <span class="muted">${num(g.age)} р.</span>`,
            week(
                schedule.entries.filter((e) => e.groupId === g.id),
                v
            )
        )
    );
    return section(
        'schedule',
        'Розклад',
        head + unplaced + legend + grids.join('\n')
    );
}

/** A week of a group: rows of 15 minutes from 09:00, a column a day. */
function week(entries, v) {
    const starts = new Map(entries.map((e) => [`${e.day}|${e.slot}`, e]));
    const covered = new Set();
    const rows = [];
    for (let slot = 0; slot < SLOTS; slot++) {
        const cells = [`<th class="time">${slotTime(slot)}</th>`];
        for (const day of DAYS) {
            if (covered.has(`${day}|${slot}`)) continue;
            const event = starts.get(`${day}|${slot}`);
            if (!event) {
                cells.push('<td></td>');
                continue;
            }
            for (let s = slot + 1; s < slot + event.length; s++) {
                covered.add(`${day}|${s}`);
            }
            cells.push(
                `<td rowspan="${event.length}" class="${esc(event.kind)}">${eventText(event, v)}</td>`
            );
        }
        rows.push(`<tr>${cells.join('')}</tr>`);
    }
    return `<table class="week"><thead><tr><th></th>${DAYS.map((d) => `<th>${DAY_NAMES[d]}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function eventText(event, v) {
    const time = `<span class="muted">${esc(event.start)}–${esc(event.end)}</span>`;
    if (event.kind === 'MEAL') return `${MEALS[event.meal] ?? 'Їжа'} ${time}`;
    if (event.kind === 'SLEEP') return `Сон ${time}`;
    const subject =
        v.subjectsById.get(event.subjectId)?.name ?? '— предмет видалено';
    const teacher = v.teachersById.get(event.teacherId);
    const room = v.roomsById.get(event.roomId);
    return `<b>${esc(subject)}</b> ${time}<br>${teacher ? esc(teacher.lastName) : missing()}, ${room ? esc(room.name) : missing()}`;
}

function moneySection(v) {
    const settings = table(
        ['Значення', ''],
        Object.entries(SETTINGS).map(([key, label]) => {
            const value = v.settings[key];
            const shown =
                key === 'annualDiscount'
                    ? percent(value)
                    : [
                            'workdaysPerMonth',
                            'extraKidsThreshold',
                            'lessonMinutes',
                        ].includes(key)
                      ? num(value)
                      : money(value);
            return [esc(label), shown];
        })
    );
    const byGroup = (report, withExpenses) =>
        table(
            [
                'Група',
                'Дітей',
                'Дохід: навчання',
                'Дохід: харчування',
                ...(withExpenses ? ['Витрати', 'Прибуток'] : []),
            ],
            [
                ...report.groups.map((g) => [
                    esc(g.name),
                    num(g.kids),
                    money(g.income.tuition),
                    money(g.income.meals),
                    ...(withExpenses
                        ? [money(g.expenses.total), signed(g.profit)]
                        : []),
                ]),
            ]
        );
    const shared = v.report.shared;
    const sharedRows = [
        ['Менеджери', shared.managers],
        ['Викладачі', shared.teachers],
        ['Помічники без групи', shared.assistantsWithoutGroup],
        ['Кімнати для занять', shared.classRooms],
    ].map(([label, line]) => [esc(label), num(line.count), money(line.amount)]);
    const totals = (total) =>
        `<p><b>Разом:</b> дохід ${money(total.income)}, витрати ${money(total.expenses)}, прибуток ${signed(total.profit)}.</p>`;
    return section(
        'money',
        'Гроші',
        `<div class="columns">
<div><h3>Фінансові налаштування</h3>${settings}</div>
<div>
<h3>Прибуток за місяць, за нарахуваннями</h3>
<p class="muted">Що садок заробляє за місяць за поточного складу й цін (FR-017).</p>
${byGroup(v.report, true)}
<h3>Спільні витрати</h3>
${table(['', 'Кількість', 'На місяць'], sharedRows)}
${totals(v.report.total)}
<h3>Отримано за ${esc(v.cash.month)}, за платежами</h3>
<p class="muted">Гроші, що надійшли цього місяця; витрати — як за нарахуваннями.</p>
${byGroup(v.cash, false)}
${totals(v.cash.total)}
</div>
</div>`
    );
}

function invoicesSection(v) {
    const paid = v.invoices.filter((i) => i.status === 'PAID');
    const unpaid = v.invoices.filter((i) => i.status === 'UNPAID');
    const sum = (list) => list.reduce((s, i) => s + i.total, 0);
    const period = (i) =>
        i.kind === 'ANNUAL'
            ? `рік з ${esc(i.periodStart.slice(0, 7))}`
            : esc(i.periodStart.slice(0, 7));
    return section(
        'invoices',
        'Рахунки й платежі',
        `<div class="tiles">
<div class="tile"><div class="value">${num(v.invoices.length)}</div><div class="label">Рахунків виставлено</div></div>
<div class="tile"><div class="value">${num(paid.length)}</div><div class="label">Оплачено, ${money(sum(paid))}</div></div>
<div class="tile"><div class="value ${unpaid.length ? 'bad' : ''}">${num(unpaid.length)}</div><div class="label">Не оплачено, ${money(sum(unpaid))}</div></div>
<div class="tile"><div class="value">${num(v.payments.length)}</div><div class="label">Платежів</div></div>
</div>
${details(
    `Неоплачені рахунки <span class="muted">${num(unpaid.length)}</span>`,
    table(
        ['Дитина', 'Період', 'Сума'],
        unpaid.map((i) => [esc(i.kidName), period(i), money(i.total)])
    )
)}
${details(
    `Платежі <span class="muted">${num(v.payments.length)}</span>`,
    table(
        ['Коли', 'Дитина', 'Сума', 'Спосіб', 'Записав'],
        v.payments.map((p) => [
            esc(dateTime(p.paidAt)),
            esc(p.kidName),
            money(p.amount),
            p.method === 'CASH' ? 'готівка' : 'картка',
            esc(v.usersById.get(p.paidById)?.username ?? '—'),
        ])
    )
)}`
    );
}

function usersSection(v) {
    const linked = (u) =>
        person(
            v.parentsById.get(u.parentId) ??
                v.educatorsById.get(u.educatorId) ??
                v.teachersById.get(u.teacherId),
            ''
        );
    return section(
        'users',
        'Облікові записи',
        `<p class="muted">Лише дані для входу; паролі зберігаються як хеш і не показуються.</p>
${table(
    ['Логін', 'Роль', 'Чий'],
    v.users.map((u) => [
        esc(u.username),
        esc(ROLES[u.role] ?? u.role),
        linked(u),
    ])
)}`
    );
}

function changesSection(v) {
    const label = (c) => {
        const record = c.after ?? c.before ?? {};
        const name =
            record.name ??
            record.username ??
            record.kidName ??
            (record.firstName
                ? `${record.firstName} ${record.lastName}`
                : null);
        return name
            ? esc(name)
            : `<span class="muted">${esc(c.id.slice(-8))}</span>`;
    };
    const ops = { create: 'створено', update: 'змінено', delete: 'видалено' };
    return section(
        'changes',
        'Історія змін',
        `<p class="muted">Останні ${num(v.changes.length)} змін (FR-15), найновіші першими.</p>
${table(
    ['Коли', 'Хто', 'Що', 'Колекція', 'Запис', 'Поля'],
    v.changes.map((c) => [
        esc(dateTime(c.at)),
        c.user ? esc(c.user.username) : '<span class="muted">система</span>',
        esc(ops[c.op] ?? c.op),
        esc(c.collection),
        label(c),
        c.op === 'update' ? esc(c.changedFields.join(', ')) : '',
    ])
)}`
    );
}

// ---- pieces -----------------------------------------------------------------

function section(id, title, body) {
    return `<section id="${id}"><h2>${esc(title)}</h2>\n${body}\n</section>`;
}

function details(summary, body) {
    return `<details><summary>${summary}</summary>${body}</details>`;
}

/** Cells are HTML already: each value is escaped where it is made. */
function table(headers, rows) {
    if (rows.length === 0) return '<p class="muted">Немає записів.</p>';
    return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
        .map(
            (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`
        )
        .join('')}</tbody></table>`;
}

function person(record, empty = missing()) {
    return record ? esc(`${record.lastName} ${record.firstName}`) : empty;
}

function discount(record) {
    return record ? `${esc(record.name)} (${percent(record.rate)})` : '';
}

function missing() {
    return '<span class="bad">—</span>';
}

function scheduleState(schedule) {
    if (!schedule) return 'немає';
    return schedule.status === 'PUBLISHED' ? 'опублікований' : 'чорновик';
}

/**
 * Escapes text for HTML, attributes included.
 * @param {*} value
 * @returns {string}
 */
export function esc(value) {
    return String(value ?? '').replace(
        /[&<>"']/g,
        (c) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            })[c]
    );
}

function num(value) {
    return esc(new Intl.NumberFormat('uk-UA').format(value ?? 0));
}

function money(value) {
    return esc(
        `${new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(value ?? 0)} грн`
    );
}

function signed(value) {
    return value < 0
        ? `<span class="bad">${money(value)}</span>`
        : money(value);
}

function percent(rate) {
    return esc(`${Math.round((rate ?? 0) * 1000) / 10}%`);
}

function dateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('uk-UA', {
        timeZone: TIME_ZONE,
        dateStyle: 'medium',
        timeStyle: 'short',
    });
}

function slotTime(slot) {
    const minutes = 9 * 60 + slot * 15;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

const STYLE = `
:root { --bg: #fff; --fg: #1c1f24; --muted: #6b7280; --line: #e5e7eb; --head: #f3f4f6;
  --accent: #2563eb; --lesson: #dbeafe; --meal: #fef3c7; --sleep: #ede9fe; --bad: #b91c1c; --ok: #15803d; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #111418; --fg: #e5e7eb; --muted: #9ca3af; --line: #2b3038; --head: #1b1f25;
    --accent: #60a5fa; --lesson: #1e3a5f; --meal: #4a3b12; --sleep: #3b2f5e; --bad: #f87171; --ok: #4ade80; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
header { position: sticky; top: 0; z-index: 1; background: var(--bg); border-bottom: 1px solid var(--line); padding: 12px 24px 8px; }
h1 { margin: 0; font-size: 22px; }
h2 { margin: 32px 0 12px; font-size: 19px; }
h3 { margin: 20px 0 8px; font-size: 15px; }
nav { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 6px; }
nav a { color: var(--accent); text-decoration: none; }
main { padding: 0 24px 48px; max-width: 1400px; }
section { scroll-margin-top: 110px; }
.muted { color: var(--muted); }
.bad { color: var(--bad); }
.ok { color: var(--ok); }
.warn { color: var(--bad); font-weight: 600; }
.tag { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--sleep); }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin: 12px 0; }
.tile { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.tile .value { font-size: 20px; font-weight: 600; overflow-wrap: anywhere; }
.tile .value.text { font-size: 16px; }
.tile .label { color: var(--muted); font-size: 12px; }
.columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 0 24px; align-items: start; }
table { border-collapse: collapse; width: 100%; margin: 6px 0 12px; }
th, td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; vertical-align: top; }
thead th { background: var(--head); position: sticky; top: 0; }
tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--head) 50%, transparent); }
details { border: 1px solid var(--line); border-radius: 8px; margin: 8px 0; padding: 6px 12px; }
summary { cursor: pointer; font-weight: 600; }
table.week { table-layout: fixed; font-size: 12px; }
table.week td, table.week th { padding: 2px 6px; height: 18px; }
table.week th.time { width: 60px; color: var(--muted); font-weight: 400; }
table.week td.LESSON, .legend .LESSON { background: var(--lesson); }
table.week td.MEAL, .legend .MEAL { background: var(--meal); }
table.week td.SLEEP, .legend .SLEEP { background: var(--sleep); }
.legend span { display: inline-block; padding: 2px 10px; margin-right: 6px; border: 1px solid var(--line); border-radius: 6px; }
@media print { header { position: static; } details { break-inside: avoid; } details:not([open]) > *:not(summary) { display: block; } }
`;
