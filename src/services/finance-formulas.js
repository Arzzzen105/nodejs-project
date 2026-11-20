/**
 * Formulas of money (EPIC-04), as plain functions of the settings: the price
 * of a kid, the report and the forecast all count the same way. Every amount
 * is in hryvnias, rounded to kopecks.
 */

/**
 * @param {number} amount
 * @returns {number} Rounded to kopecks
 */
export function money(amount) {
    return Math.round(amount * 100) / 100;
}

/**
 * Meals of a kid of an age for a month: what the parents pay and what the
 * kindergarten pays for them (BR-22, BR-23, BR-33). Meals are paid monthly
 * and no discount applies to them (BR-30–BR-32).
 * @param {object} settings
 * @param {number} age 2–5
 * @returns {{ pricePerDay: number, costPerDay: number, days: number, perMonth: number, costPerMonth: number }}
 */
export function meals(settings, age) {
    const pricePerDay = settings[`mealPriceAge${age}`];
    const costPerDay = settings[`mealCostAge${age}`];
    const days = settings.workdaysPerMonth;
    return {
        pricePerDay,
        costPerDay,
        days,
        perMonth: money(pricePerDay * days),
        costPerMonth: money(costPerDay * days),
    };
}

/**
 * Tuition of a kid for a month (FR-012, FR-013): the base price, less the
 * discount of the kid, less the annual discount on what is left when the
 * year is paid in advance (BR-28).
 * @param {object} settings
 * @param {object} options
 * @param {number} [options.discountRate=0] Rate of the kid's discount, 0–1
 * @param {'MONTHLY'|'ANNUAL'} [options.paymentPlan='MONTHLY']
 * @returns {{ base: number, discountRate: number, discount: number, afterDiscount: number, annualDiscountRate: number, annualDiscount: number, perMonth: number }}
 */
export function tuition(
    settings,
    { discountRate = 0, paymentPlan = 'MONTHLY' } = {}
) {
    const base = settings.tuitionPerMonth;
    const discount = money(base * discountRate);
    const afterDiscount = money(base - discount);
    const annualDiscountRate =
        paymentPlan === 'ANNUAL' ? settings.annualDiscount : 0;
    const annualDiscount = money(afterDiscount * annualDiscountRate);
    return {
        base,
        discountRate,
        discount,
        afterDiscount,
        annualDiscountRate,
        annualDiscount,
        perMonth: money(afterDiscount - annualDiscount),
    };
}

/**
 * What a kid costs their parents (FR-012): tuition and meals for a month,
 * and how it is paid. On the annual plan the tuition of the year is paid in
 * advance, and only the meals monthly (BR-32).
 * @param {object} settings
 * @param {{ age: number, paymentPlan?: string }} kid
 * @param {number} [discountRate=0] Rate of the kid's discount, 0–1
 */
export function kidPrice(settings, kid, discountRate = 0) {
    const paymentPlan = kid.paymentPlan ?? 'MONTHLY';
    const fees = tuition(settings, { discountRate, paymentPlan });
    const food = meals(settings, kid.age);
    const annual = paymentPlan === 'ANNUAL';
    return {
        paymentPlan,
        tuition: fees,
        meals: {
            pricePerDay: food.pricePerDay,
            days: food.days,
            perMonth: food.perMonth,
        },
        totalPerMonth: money(fees.perMonth + food.perMonth),
        payments: {
            upfront: annual ? money(fees.perMonth * 12) : 0,
            monthly: annual
                ? food.perMonth
                : money(fees.perMonth + food.perMonth),
        },
    };
}

/**
 * Salary of the educator of a group of `kids` (BR-37, BR-38): a rate for
 * each kid and a bonus for each kid over the threshold.
 * @param {object} settings
 * @param {number} kids
 * @returns {number}
 */
export function educatorSalary(settings, kids) {
    const extra = Math.max(0, kids - settings.extraKidsThreshold);
    return money(
        kids * settings.educatorPayPerKid +
            extra * settings.educatorBonusPerExtraKid
    );
}

/**
 * Salary of the assistant of a group of `kids` (BR-36, BR-39): a base and a
 * bonus for each kid over the threshold.
 * @param {object} settings
 * @param {number} kids
 * @returns {number}
 */
export function assistantSalary(settings, kids) {
    const extra = Math.max(0, kids - settings.extraKidsThreshold);
    return money(
        settings.assistantBaseSalary +
            extra * settings.assistantBonusPerExtraKid
    );
}

/**
 * @typedef {object} ReportGroup A group as the report needs it
 * @property {string|null} id
 * @property {string} name
 * @property {number} age
 * @property {boolean} hasEducator
 * @property {boolean} hasAssistant
 * @property {number} rooms Rooms of the group (one, by BR-17)
 * @property {Array<{ age: number, paymentPlan?: string, discountRate?: number }>} kids
 */

/**
 * @typedef {object} ReportInput The kindergarten as the report needs it,
 *   real (the report) or hypothetical (the forecast)
 * @property {ReportGroup[]} groups
 * @property {number} managers
 * @property {number} teachers
 * @property {number} assistantsWithoutGroup They still get the base salary
 * @property {number} classRooms Rooms of no group: for classes, or free
 */

/**
 * Income, expenses and profit of a month (FR-017), by the method of accrual:
 * what the kindergarten earns and spends in a month with these groups.
 * - The annual payment counts as a twelfth each month, so paying a year in
 *   advance does not swell the profit of one month.
 * - Meals paid by the parents are income and meals bought are expenses, two
 *   lines even when equal (BR-33).
 * - What belongs to no group (managers, teachers, rooms for classes,
 *   assistants without a group) is shared; the profits of the groups less
 *   the shared expenses are the total profit.
 * @param {object} settings
 * @param {ReportInput} input
 */
export function profitReport(settings, input) {
    const groups = input.groups.map((group) => groupReport(settings, group));
    const line = (count, rate) => ({ count, amount: money(count * rate) });
    const lines = {
        managers: line(input.managers, settings.managerSalary),
        teachers: line(input.teachers, settings.teacherSalary),
        assistantsWithoutGroup: line(
            input.assistantsWithoutGroup,
            settings.assistantBaseSalary
        ),
        classRooms: line(input.classRooms, settings.roomCostPerMonth),
    };
    const shared = {
        ...lines,
        total: sum(Object.values(lines).map((entry) => entry.amount)),
    };
    const income = sum(groups.map((group) => group.income.total));
    const expenses = money(
        sum(groups.map((group) => group.expenses.total)) + shared.total
    );
    return {
        groups,
        shared,
        total: { income, expenses, profit: money(income - expenses) },
    };
}

/**
 * @param {object} settings
 * @param {ReportGroup} group
 */
function groupReport(settings, group) {
    const count = group.kids.length;
    let tuitionIncome = 0;
    let mealIncome = 0;
    let mealCost = 0;
    for (const kid of group.kids) {
        tuitionIncome += tuition(settings, {
            discountRate: kid.discountRate ?? 0,
            paymentPlan: kid.paymentPlan,
        }).perMonth;
        const food = meals(settings, kid.age);
        mealIncome += food.perMonth;
        mealCost += food.costPerMonth;
    }
    const income = {
        tuition: money(tuitionIncome),
        meals: money(mealIncome),
    };
    income.total = money(income.tuition + income.meals);
    const expenses = {
        meals: money(mealCost),
        educator: group.hasEducator ? educatorSalary(settings, count) : 0,
        assistant: group.hasAssistant ? assistantSalary(settings, count) : 0,
        room: money(group.rooms * settings.roomCostPerMonth),
    };
    expenses.total = sum(Object.values(expenses));
    return {
        groupId: group.id,
        name: group.name,
        age: group.age,
        kids: count,
        income,
        expenses,
        profit: money(income.total - expenses.total),
    };
}

/**
 * @param {number[]} amounts
 * @returns {number} Their sum, rounded to kopecks
 */
function sum(amounts) {
    return money(amounts.reduce((total, amount) => total + amount, 0));
}
