// Ukrainian collation: "Ґ" follows "Г" and "Є", "І", "Ї" sit among the other
// letters (by code point "Є", "І", "Ї" come before "А" and "Ґ" after "Я"), and
// digits compare as numbers, so "Група 2" comes before "Група 10". Case does
// not split the order: "adams" comes before "Baker", not after all capitals.
const collator = new Intl.Collator('uk', { numeric: true });

// The apostrophe does not count in alphabetical order, in Ukrainian ("Марія"
// before "Мар'яна") as in English ("Obama" before "O'Brien"). The collator
// would put it before every letter. Typewriter, typographic and modifier forms.
const APOSTROPHES = /['’ʼ]/g;

/**
 * Compares text the way people read it; used for `string` columns by both
 * sorting and range filters, so a range is always a slice of the sorted order.
 * Only equal strings compare as equal: text that differs just in apostrophes
 * is ordered by them, so the order stays strict.
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative, zero or positive
 */
export function compareText(a, b) {
    return (
        collator.compare(
            a.replace(APOSTROPHES, ''),
            b.replace(APOSTROPHES, '')
        ) ||
        collator.compare(a, b) ||
        compareCodePoints(a, b)
    );
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
