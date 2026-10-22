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
