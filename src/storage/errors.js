export class DatabaseError extends Error {
    constructor(message, status = 500, code = 'INTERNAL_ERROR') {
        super(message);
        this.name = 'DatabaseError';
        this.status = status;
        this.code = code;
    }
}
