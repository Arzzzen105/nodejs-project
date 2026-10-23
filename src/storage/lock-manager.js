/**
 * Lock key of a single record. Every module locking records must build keys
 * through this function: keys are compared as plain strings, so two formats
 * for the same record would silently become two independent locks.
 * @param {string} collection
 * @param {string} id
 * @returns {string}
 */
export function lockKey(collection, id) {
    return `${collection}:${id}`;
}

/**
 * Asynchronous keyed mutex queue to ensure serialized execution
 * of operations on the same entity (e.g., collection:recordId).
 */
export class LockManager {
    #locks = new Map();

    /**
     * Executes the given async operation while holding the lock for the given key.
     * @param {string} key
     * @param {() => Promise<*>} operation
     * @returns {Promise<*>}
     */
    async withLock(key, operation) {
        const previous = this.#locks.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise((resolve) => {
            release = resolve;
        });
        this.#locks.set(key, current);
        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this.#locks.get(key) === current) {
                this.#locks.delete(key);
            }
        }
    }
}

/**
 * Readers-writer lock: any number of readers at once, or a single writer.
 * Requests are served in arrival order, so a waiting writer is not starved by
 * readers arriving after it.
 */
export class ReadWriteLock {
    #readers = 0;
    #writing = false;
    #queue = [];

    /**
     * @param {() => Promise<*>} operation
     * @returns {Promise<*>}
     */
    async withRead(operation) {
        await this.#acquire('read');
        try {
            return await operation();
        } finally {
            this.#readers--;
            this.#drain();
        }
    }

    /**
     * @param {() => Promise<*>} operation
     * @returns {Promise<*>}
     */
    async withWrite(operation) {
        await this.#acquire('write');
        try {
            return await operation();
        } finally {
            this.#writing = false;
            this.#drain();
        }
    }

    #acquire(mode) {
        return new Promise((resolve) => {
            this.#queue.push({ mode, resolve });
            this.#drain();
        });
    }

    #drain() {
        while (this.#queue.length > 0 && !this.#writing) {
            const next = this.#queue[0];
            if (next.mode === 'write') {
                if (this.#readers > 0) return;
                this.#queue.shift();
                this.#writing = true;
                next.resolve();
                return;
            }
            this.#queue.shift();
            this.#readers++;
            next.resolve();
        }
    }
}
