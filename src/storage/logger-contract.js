/**
 * Logger accepted by the storage engine. The engine never picks a logging
 * library: the application passes one in (pino, winston, ...), the same way a
 * Java library logs through SLF4J. Methods follow the pino convention:
 * structured fields first, then the message.
 *
 * The engine logs ids, counts and durations only, never record contents:
 * records hold personal data that must not leak into logs.
 *
 * @typedef {object} Logger
 * @property {(fields: object, message: string) => void} debug
 * @property {(fields: object, message: string) => void} info
 * @property {(fields: object, message: string) => void} warn
 * @property {(fields: object, message: string) => void} error
 */

const LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * Used when the application passes no logger: debug and info are silent,
 * problems go to the console so they are never lost.
 * @type {Logger}
 */
export const defaultLogger = Object.freeze({
    debug() {},
    info() {},
    warn: (fields, message) => console.warn(format(fields, message)),
    error: (fields, message) => console.error(format(fields, message)),
});

/**
 * @param {*} logger
 * @throws {TypeError} unless every log level is a function
 */
export function assertLogger(logger) {
    const missing = LEVELS.find(
        (level) => typeof logger?.[level] !== 'function'
    );
    if (missing !== undefined) {
        throw new TypeError(
            `"logger" must have ${LEVELS.join('/')} methods (missing "${missing}").`
        );
    }
}

function format(fields, message) {
    const details =
        fields && Object.keys(fields).length > 0
            ? ` ${JSON.stringify(fields, serializeErrors)}`
            : '';
    return `[file-database] ${message}${details}`;
}

// JSON.stringify turns an Error into {}, so keep its useful parts.
function serializeErrors(_key, value) {
    return value instanceof Error
        ? { message: value.message, code: value.code }
        : value;
}
