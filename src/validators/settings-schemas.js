import { z } from 'zod';

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
