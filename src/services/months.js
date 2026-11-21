/**
 * Months of the money of the kindergarten (EPIC-06): of invoices, as days,
 * and of payments, as moments in the time of Kyiv, where the kindergarten is.
 */

/** Time zone of the kindergarten: a month of payments begins at its midnight. */
export const TIME_ZONE = 'Europe/Kyiv';

/**
 * The days of some months from one.
 * @param {string} period The first month, `YYYY-MM`
 * @param {number} months How many
 * @returns {{ start: string, end: string }} First and last day, `YYYY-MM-DD`
 * @example
 * monthOf('2026-11', 12); // { start: '2026-11-01', end: '2027-10-31' }
 */
export function monthOf(period, months) {
    const [year, month] = period.split('-').map(Number);
    // day 0 of a month is the last day of the month before it
    const last = new Date(Date.UTC(year, month - 1 + months, 0));
    return {
        start: `${period}-01`,
        end: last.toISOString().slice(0, 10),
    };
}

/**
 * When a month begins and ends in Kyiv, for a filter on a `datetime`: from
 * the midnight of its first day to the midnight of the next month.
 * @param {string} period `YYYY-MM`
 * @returns {{ from: string, to: string }} ISO 8601 with the offset of Kyiv;
 *   `to` is not in the month
 * @example
 * monthMoments('2026-11');
 * // { from: '2026-11-01T00:00:00+02:00', to: '2026-12-01T00:00:00+02:00' }
 */
export function monthMoments(period) {
    const [year, month] = period.split('-').map(Number);
    const next = month === 12 ? [year + 1, 1] : [year, month + 1];
    return { from: midnight(year, month), to: midnight(...next) };
}

/**
 * The month of a moment in Kyiv.
 * @param {Date} [date]
 * @returns {string} `YYYY-MM`
 */
export function monthAt(date = new Date()) {
    // the Swedish format is ISO: 2026-11-21
    return date
        .toLocaleDateString('sv-SE', { timeZone: TIME_ZONE })
        .slice(0, 7);
}

/**
 * The midnight of the first day of a month in Kyiv. Clocks change on the
 * last Sunday of March and of October at night, never on a first day, so
 * the offset at noon of the day is that of its midnight.
 */
function midnight(year, month) {
    const noon = new Date(Date.UTC(year, month - 1, 1, 12));
    const offset = new Intl.DateTimeFormat('en', {
        timeZone: TIME_ZONE,
        timeZoneName: 'longOffset',
    })
        .formatToParts(noon)
        .find((part) => part.type === 'timeZoneName')
        .value.replace('GMT', '');
    const mm = String(month).padStart(2, '0');
    return `${year}-${mm}-01T00:00:00${offset || '+00:00'}`;
}
