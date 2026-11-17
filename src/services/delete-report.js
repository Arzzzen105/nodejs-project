/**
 * @typedef {import('../storage/transaction.js').DeleteReport} DeleteReport
 */

/**
 * Joins the reports of several deletes made by one use case into one, as if
 * the database had deleted everything at once.
 * @param {DeleteReport[]} reports
 * @returns {DeleteReport}
 */
export function mergeReports(reports) {
    return {
        deleted: reports.flatMap((report) => report.deleted),
        updated: reports.flatMap((report) => report.updated),
    };
}
