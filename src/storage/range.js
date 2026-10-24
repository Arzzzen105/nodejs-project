import { compareCodePoints } from './collation.js';

const ORDERABLE_TYPES = new Set(['number', 'string']);

/**
 * @param {number} a
 * @param {number} b
 * @returns {number} Negative, zero or positive
 */
function compareNumbers(a, b) {
    if (a < b) return -1;
    return a > b ? 1 : 0;
}

/**
 * Checks whether a value satisfies range bounds.
 * Only numbers and strings are ordered: null, missing values and values whose type
 * differs from a bound never match (JS would otherwise coerce e.g. `null < 5` to true).
 * @param {*} value
 * @param {{ gt?: *, gte?: *, lt?: *, lte?: * }} bounds
 * @param {(a: string, b: string) => number} [compareStrings=compareCodePoints]
 *   How strings are ordered; `string` columns use compareText, as sorting does
 * @returns {boolean}
 */
export function matchesRange(
    value,
    { gt, gte, lt, lte },
    compareStrings = compareCodePoints
) {
    if (!ORDERABLE_TYPES.has(typeof value)) return false;
    const comparable = (bound) =>
        bound === undefined || typeof bound === typeof value;
    if (![gt, gte, lt, lte].every(comparable)) return false;

    const compare = typeof value === 'string' ? compareStrings : compareNumbers;
    if (gt !== undefined && !(compare(value, gt) > 0)) return false;
    if (gte !== undefined && !(compare(value, gte) >= 0)) return false;
    if (lt !== undefined && !(compare(value, lt) < 0)) return false;
    if (lte !== undefined && !(compare(value, lte) <= 0)) return false;
    return true;
}
