/**
 * Logger for tests: remembers every entry instead of printing it.
 * @returns {import('../../src/storage/logger-contract.js').Logger & {
 *   entries: Array<{ level: string, fields: object, message: string }>,
 *   at: (level: string) => Array<{ level: string, fields: object, message: string }>
 * }}
 */
export function createTestLogger() {
    const entries = [];
    const log = (level) => (fields, message) =>
        entries.push({ level, fields, message });
    return {
        entries,
        at: (level) => entries.filter((entry) => entry.level === level),
        debug: log('debug'),
        info: log('info'),
        warn: log('warn'),
        error: log('error'),
    };
}
