/**
 * Custom error class used across the storage layer.
 */
export class DatabaseError extends Error {
    /**
     * @param {string} message Human-readable error description
     * @param {number} [status=500] HTTP response status code
     * @param {string} [code='INTERNAL_ERROR'] Machine-readable error code
     */
    constructor(message, status = 500, code = 'INTERNAL_ERROR') {
        super(message);
        this.name = 'DatabaseError';
        this.status = status;
        this.code = code;
    }
}
