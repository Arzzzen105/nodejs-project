// Ukrainian collation: "Ґ" follows "Г" and "Є", "І", "Ї" sit among the other
// letters (by code point "Є", "І", "Ї" come before "А" and "Ґ" after "Я"), and
// digits compare as numbers, so "Група 2" comes before "Група 10".
const collator = new Intl.Collator('uk', { numeric: true });

/**
 * Compares text the way people read it; used for `string` columns by both
 * sorting and range filters, so a range is always a slice of the sorted order.
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative, zero or positive
 */
export function compareText(a, b) {
    return collator.compare(a, b);
}

/**
 * Plain code point comparison, used for ids, dates and datetimes: their fixed
 * format already orders them by time.
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative, zero or positive
 */
export function compareCodePoints(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}
