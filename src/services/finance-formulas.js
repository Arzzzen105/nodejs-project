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
