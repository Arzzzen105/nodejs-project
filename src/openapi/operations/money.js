import { items, money, object, page, record } from '../schemas.js';

/**
 * What the reference says about money: the financial settings, the price of
 * a kid, the profit report and the forecast (EPIC-04), invoices and payments
 * (EPIC-06). See entities.js for the form of an entry.
 */

const income = object({ tuition: money, meals: money, total: money });

const groupReport = object({
    groupId: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'null in a forecast: the group is only planned',
    },
    name: { type: 'string' },
    age: { type: 'integer' },
    kids: { type: 'integer' },
    income,
    expenses: object({
        meals: { ...money, description: 'Meals bought (BR-33)' },
        educator: money,
        assistant: money,
        room: money,
        total: money,
    }),
    profit: money,
});

const counted = object({ count: { type: 'integer' }, amount: money });

const shared = object(
    {
        managers: counted,
        teachers: counted,
        assistantsWithoutGroup: counted,
        classRooms: counted,
        total: money,
    },
    'Expenses of no group: managers, teachers, rooms for classes, assistants without a group.'
);

const total = object({ income: money, expenses: money, profit: money });

const report = {
    type: 'object',
    required: ['asOf', 'basis', 'groups', 'shared', 'total'],
    properties: {
        asOf: { type: 'string', format: 'date-time' },
        basis: { type: 'string', enum: ['ACCRUAL', 'CASH'] },
        amountsPer: {
            type: 'string',
            enum: ['MONTH'],
            description: 'ACCRUAL only',
        },
        month: { type: 'string', description: 'CASH only: `YYYY-MM`' },
        from: {
            type: 'string',
            description: 'CASH only: the month begins, in Kyiv',
        },
        to: {
            type: 'string',
            description: 'CASH only: the next month begins',
        },
        expensesBasis: {
            type: 'string',
            enum: ['ACCRUAL'],
            description:
                'CASH only: expenses are counted by accrual; money spent is not recorded',
        },
        groups: { type: 'array', items: groupReport },
        withoutGroup: {
            ...income,
            description:
                'CASH only: money for invoices of groups deleted since',
        },
        shared,
        total,
    },
};

const kidPrice = object({
    kidId: { type: 'string', format: 'uuid' },
    paymentPlan: { type: 'string', enum: ['MONTHLY', 'ANNUAL'] },
    tuition: object({
        base: money,
        discountRate: { type: 'number' },
        discount: money,
        afterDiscount: money,
        annualDiscountRate: { type: 'number' },
        annualDiscount: money,
        perMonth: money,
    }),
    meals: object({
        pricePerDay: money,
        days: { type: 'integer' },
        perMonth: money,
    }),
    totalPerMonth: money,
    payments: object(
        { upfront: money, monthly: money },
        'What is paid: the year in advance on the annual plan, and every month.'
    ),
});

const paymentWithInvoices = {
    allOf: [
        record('payments'),
        object({ invoices: { type: 'array', items: record('invoices') } }),
    ],
};

export const MONEY = {
    'GET /api/finance/settings': {
        summary: 'Financial settings',
        description:
            'Prices, discounts, salaries and costs (FR-016): one record. The values of the requirements are the defaults.',
        response: { schema: record('settings') },
    },
    'PATCH /api/finance/settings': {
        summary: 'Change financial settings',
        description:
            'Any of the values (BR-24, BR-40, NFR-06); only ranges are checked. Invoices already issued keep their amounts. `lessonMinutes` is the length of every lesson (BR-59).',
        response: { schema: record('settings') },
    },
    'GET /api/finance/report': {
        summary: 'Profit report',
        description: [
            'Income, expenses and profit of each group and of the kindergarten (FR-017), by one of two methods (`basis`):',
            '- `ACCRUAL` (the default): what the kindergarten earns in a month, counted from its kids, groups, staff and current prices; a year paid in advance counts as a twelfth each month;',
            '- `CASH` with `month`: the money that came in that month, by the invoices paid; a year paid in advance is income of the month it was paid in. Expenses are those of ACCRUAL.',
            '',
            'Meals paid by the parents are income, meals bought are expenses: two lines (BR-33). A kid without a group is not counted.',
        ].join('\n'),
        query: {
            basis: '`ACCRUAL` (default) or `CASH`.',
            month: 'With `basis=CASH` only: `YYYY-MM`, in Kyiv.',
        },
        response: { schema: report },
    },
    'POST /api/finance/forecast': {
        summary: 'Forecast profit',
        description:
            'What the kindergarten would earn with these kids (2.1): they are put in the most profitable groups the 15 rooms allow, with the staff and rooms they need, at the current prices. What belongs to no group stays as now. Nothing is stored. `fewestGroups` is the same kids in the fewest groups, to compare; `now`, the kindergarten as it is.',
        status: 200,
        response: {
            schema: {
                allOf: [
                    report,
                    object({
                        assumptions: { type: 'object' },
                        fewestGroups: object({
                            groups: { type: 'integer' },
                            total,
                        }),
                        now: total,
                    }),
                ],
            },
        },
        errors: [
            [
                422,
                'TOO_MANY_GROUPS',
                'The kids need more than 15 groups of 20 (BR-19).',
            ],
        ],
    },
    'GET /api/kids/{id}/price': {
        summary: 'What a kid costs',
        description:
            'Tuition with the discount of the kid and the annual discount, meals, and what is paid when (FR-012, FR-013). Parents see it for their own kids.',
        response: { schema: kidPrice },
        errors: [[403, 'FORBIDDEN', 'Not their kid.']],
    },

    'GET /api/invoices': {
        summary: 'List invoices',
        description:
            'A parent sees the invoices of their kids only. E.g. what is owed: `where={"status":"UNPAID"}`; a month: `where={"periodStart":"2026-11-01"}`.',
        response: { schema: page('invoices') },
    },
    'POST /api/invoices': {
        summary: 'Invoice a kid for a month',
        description:
            'Issues what the kid owes for the month (FR-014): a MONTHLY invoice with the meals (BR-32) and the tuition, unless an annual invoice covers the month; on the annual plan, if none covers it, also an ANNUAL invoice for the tuition of 12 months (FR-013). Lines are fixed now: later prices do not change them.',
        response: {
            description: 'The new invoices, the annual one first.',
            schema: items('invoices'),
        },
        errors: [
            [404, 'NOT_FOUND', 'No such kid.'],
            [409, 'INVOICE_EXISTS', 'The kid is invoiced for the month.'],
            [
                422,
                'KID_NOT_ENROLLED',
                'The kid has no group, so does not attend.',
            ],
        ],
    },
    'POST /api/invoices/batch': {
        summary: 'Invoice every kid for a month',
        description:
            'The same for every kid in a group, in one transaction. Kids already invoiced for the month are skipped, so it may be repeated: 201 with what is new, 200 when nothing is.',
        response: {
            description: 'Created; or 200 when every kid was invoiced already.',
            schema: {
                allOf: [
                    items('invoices'),
                    object({
                        skipped: {
                            type: 'integer',
                            description: 'Kids invoiced before',
                        },
                    }),
                ],
            },
        },
    },
    'GET /api/invoices/{id}': {
        summary: 'Read an invoice',
        response: { schema: record('invoices') },
        errors: [[403, 'FORBIDDEN', 'An invoice of another kid.']],
    },
    'DELETE /api/invoices/{id}': {
        summary: 'Delete an unpaid invoice',
        description:
            'E.g. one issued by mistake; the month can be issued again.',
        response: { description: 'Deleted.' },
        errors: [[409, 'INVOICE_PAID', 'A paid invoice is history: it stays.']],
    },

    'GET /api/payments': {
        summary: 'List payments',
        description:
            'The history of payments (FR-014). A parent sees those of their kids only.',
        response: { schema: page('payments') },
    },
    'POST /api/payments': {
        summary: 'Pay invoices',
        description: [
            'Pays whole invoices of one kid, none paid before; the sum is counted by the server. The payment and the invoices becoming PAID are one transaction. There is no payment system behind it: paying is recording the payment. Payments are never changed or deleted.',
            '',
            'With `Idempotency-Key` the request is safe to repeat (NFR-11): the same key and invoices answer 200 with the payment made before, not a second one.',
        ].join('\n'),
        headers: [
            {
                name: 'Idempotency-Key',
                in: 'header',
                required: false,
                description:
                    'Any string of 1–100 characters the client picks for the operation, e.g. a UUID.',
                schema: { type: 'string', minLength: 1, maxLength: 100 },
            },
        ],
        response: {
            description: 'Paid; `Location` points to the payment.',
            schema: paymentWithInvoices,
        },
        responses: {
            200: {
                description:
                    'The key was used for the same invoices: the payment made then. Header `Idempotent-Replayed: true`.',
                content: {
                    'application/json': { schema: paymentWithInvoices },
                },
            },
        },
        errors: [
            [
                400,
                'INVALID_IDEMPOTENCY_KEY',
                'The key is longer than 100 characters.',
            ],
            [403, 'FORBIDDEN', 'An invoice of another kid.'],
            [404, 'NOT_FOUND', 'No such invoice.'],
            [409, 'INVOICE_PAID', 'An invoice is paid already.'],
            [
                422,
                'INVOICES_OF_DIFFERENT_KIDS',
                'A payment pays the invoices of one kid.',
            ],
            [422, 'IDEMPOTENCY_KEY_REUSED', 'The key paid other invoices.'],
        ],
    },
    'GET /api/payments/{id}': {
        summary: 'Read a payment',
        description: 'With the invoices it paid, oldest period first.',
        response: { schema: paymentWithInvoices },
        errors: [[403, 'FORBIDDEN', 'A payment of another kid.']],
    },
};
