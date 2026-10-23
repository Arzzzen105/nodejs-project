import { AsyncLocalStorage } from 'node:async_hooks';

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
 *
 * Locks are reentrant within one async call chain: an operation that already
 * holds a key may call code that locks the same key again without deadlocking.
 */
export class LockManager {
    #locks = new Map();
    #held = new AsyncLocalStorage();

    /**
     * Executes the given async operation while holding the lock for the given key.
     * @param {string} key
     * @param {() => Promise<*>} operation
     * @returns {Promise<*>}
     */
    async withLock(key, operation) {
        const held = this.#held.getStore();
        if (held?.has(key)) {
            return operation();
        }

        const previous = this.#locks.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise((resolve) => {
            release = resolve;
        });
        this.#locks.set(key, current);
        await previous;
        try {
            const nextHeld = new Set(held);
            nextHeld.add(key);
            return await this.#held.run(nextHeld, operation);
        } finally {
            release();
            if (this.#locks.get(key) === current) {
                this.#locks.delete(key);
            }
        }
    }

    /**
     * Executes the operation while holding all given keys.
     * Keys are acquired in sorted order, so two callers locking overlapping
     * sets can never wait for each other in a cycle.
     * @param {string[]} keys
     * @param {() => Promise<*>} operation
     * @returns {Promise<*>}
     */
    async withLocks(keys, operation) {
        const sorted = [...new Set(keys)].sort();
        const acquire = (index) =>
            index === sorted.length
                ? operation()
                : this.withLock(sorted[index], () => acquire(index + 1));
        return acquire(0);
    }
}
