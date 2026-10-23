/**
 * Calendar dates ("2026-10-23") and moments in time ("2026-10-23T09:41:12.000Z")
 * stored as ISO 8601 strings. In a fixed format, comparing the strings
 * compares the dates, so range filters, sorting and indexes work unchanged.
 *
 * The built-in Date parser is too lenient to validate with: it turns
 * "2026-02-30" into March 2, accepts "24:00" and reads a time without an offset
 * in the server's time zone. Every part is therefore checked here.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/**
 * @param {number} year
 * @param {number} month 1-12
 * @returns {number}
 */
function daysInMonth(year, month) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
        month - 1
    ];
}

/**
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {boolean} Whether the day exists in the calendar
 */
function isCalendarDay(year, month, day) {
    return (
        month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
    );
}

/**
 * Checks a calendar date without time and time zone, e.g. a birthday.
 * @param {*} value
 * @returns {boolean} True for "YYYY-MM-DD" strings of days that exist
 * @example
 * isDate('2024-02-29'); // true
 * isDate('2026-02-29'); // false: 2026 is not a leap year
 */
export function isDate(value) {
    if (typeof value !== 'string') return false;
    const match = DATE.exec(value);
    if (!match) return false;
    const [, year, month, day] = match.map(Number);
    return isCalendarDay(year, month, day);
}

/**
 * Converts an ISO 8601 moment with an explicit offset to the one canonical form
 * the database stores: UTC with milliseconds. Without one form, equal moments
 * would be different strings and string order would not be time order
 * ("12:00:00.5Z" sorts before "12:00:00Z").
 * @param {*} value
 * @returns {string|null} Canonical form, or null if the value is not a valid moment
 * @example
 * normalizeDatetime('2026-10-23T12:41+03:00'); // '2026-10-23T09:41:00.000Z'
 * normalizeDatetime('2026-10-23T12:41:00');    // null: no offset, whose 12:41?
 */
export function normalizeDatetime(value) {
    if (typeof value !== 'string') return null;
    const match = DATETIME.exec(value);
    if (!match) return null;
    const [, y, mo, d, h, mi, s = '0', fraction = '', utc, sign, oh, om] =
        match;
    const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(
        Number
    );
    if (!isCalendarDay(year, month, day)) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;

    let offsetMinutes = 0;
    if (!utc) {
        if (Number(oh) > 23 || Number(om) > 59) return null;
        offsetMinutes =
            (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om));
    }
    const millis = Number(fraction.padEnd(3, '0').slice(0, 3));

    // setUTCFullYear keeps years 0-99 as they are; Date.UTC would map them to 19xx
    const moment = new Date(0);
    moment.setUTCFullYear(year, month - 1, day);
    moment.setUTCHours(hour, minute - offsetMinutes, second, millis);
    const canonical = moment.toISOString();
    // the offset may push the moment out of four-digit years ("+010000-...")
    return canonical.length === 24 ? canonical : null;
}

/**
 * @param {*} value
 * @returns {boolean} True for ISO 8601 moments with an offset ("Z" or "+03:00")
 */
export function isDatetime(value) {
    return normalizeDatetime(value) !== null;
}
