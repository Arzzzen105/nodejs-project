const ORDERABLE_TYPES = new Set(['number', 'string']);

/**
 * Checks whether a value satisfies range bounds.
 * Only numbers and strings are ordered: null, missing values and values whose type
 * differs from a bound never match (JS would otherwise coerce e.g. `null < 5` to true).
 * @param {*} value
 * @param {{ gt?: *, gte?: *, lt?: *, lte?: * }} bounds
 * @returns {boolean}
 */
export function matchesRange(value, { gt, gte, lt, lte }) {
    if (!ORDERABLE_TYPES.has(typeof value)) return false;
    const comparable = (bound) =>
        bound === undefined || typeof bound === typeof value;
    if (![gt, gte, lt, lte].every(comparable)) return false;

    if (gt !== undefined && !(value > gt)) return false;
    if (gte !== undefined && !(value >= gte)) return false;
    if (lt !== undefined && !(value < lt)) return false;
    if (lte !== undefined && !(value <= lte)) return false;
    return true;
}
