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

    /**
     * @param {'read'|'write'} mode
     * @returns {Promise<void>} Resolves when the lock is granted
     */
    #acquire(mode) {
        return new Promise((resolve) => {
            this.#queue.push({ mode, resolve });
            this.#drain();
        });
    }

    /**
     * Grants the lock to waiting requests in arrival order: consecutive readers
     * together, a writer alone once no reader is active.
     */
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
