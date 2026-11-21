import { z } from 'zod';
import { MAX_GROUPS } from '../services/group-service.js';
import { MAX_GROUP_SIZE } from '../services/kid-service.js';

/**
 * Body of PATCH /api/finance/settings (FR-016): any of the settings. Keep the
 * rules in step with database/settings/config.json:
 * tests/validators/settings-schemas.test.js compares them.
 *
 * Only ranges are checked (amounts are not negative, discounts are between 0
 * and 1): the admin may change any financial value (BR-24, BR-40).
 */
export const updateSettings = z.strictObject({
    tuitionPerMonth: z.number().min(0).optional(),
    annualDiscount: z.number().min(0).max(1).optional(),
    workdaysPerMonth: z.int().min(1).max(31).optional(),
    mealPriceAge2: z.number().min(0).optional(),
    mealPriceAge3: z.number().min(0).optional(),
    mealPriceAge4: z.number().min(0).optional(),
    mealPriceAge5: z.number().min(0).optional(),
    mealCostAge2: z.number().min(0).optional(),
    mealCostAge3: z.number().min(0).optional(),
    mealCostAge4: z.number().min(0).optional(),
    mealCostAge5: z.number().min(0).optional(),
    managerSalary: z.number().min(0).optional(),
    teacherSalary: z.number().min(0).optional(),
    assistantBaseSalary: z.number().min(0).optional(),
    assistantBonusPerExtraKid: z.number().min(0).optional(),
    educatorPayPerKid: z.number().min(0).optional(),
    educatorBonusPerExtraKid: z.number().min(0).optional(),
    extraKidsThreshold: z.int().min(0).optional(),
    roomCostPerMonth: z.number().min(0).optional(),
});

/**
 * Query string of GET /api/finance/report: nothing. The report is of the
 * kindergarten as it is now, so a parameter such as `?month=` is answered 400
 * rather than silently ignored.
 */
export const reportQuery = z.strictObject({});

const kidsOfAge = z
    .int()
    .min(0)
    .max(MAX_GROUPS * MAX_GROUP_SIZE)
    .optional();

/**
 * Body of POST /api/finance/forecast: how many kids of each age, and
 * optionally the average discount and the part of the kids paying a year in
 * advance. Whether they fit into the groups is checked by the service.
 */
export const forecastBody = z.strictObject({
    kids: z.strictObject({
        2: kidsOfAge,
        3: kidsOfAge,
        4: kidsOfAge,
        5: kidsOfAge,
    }),
    averageDiscount: z.number().min(0).max(1).optional(),
    annualShare: z.number().min(0).max(1).optional(),
});
