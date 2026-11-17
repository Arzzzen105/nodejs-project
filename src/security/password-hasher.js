import bcrypt from 'bcryptjs';

// bcrypt ignores everything after the 72nd byte of a password.
const MAX_PASSWORD_BYTES = 72;

/**
 * Hashes passwords with bcrypt and checks them against a hash. The salt is
 * part of the hash, so nothing else needs to be stored.
 *
 * @example
 * const hasher = new PasswordHasher();
 * const hash = await hasher.hash('secret-password');
 * await hasher.verify('secret-password', hash); // true
 */
export class PasswordHasher {
    #rounds;

    /**
     * @param {object} [options]
     * @param {number} [options.rounds=10] Cost of bcrypt: each extra round
     *   doubles the time of hashing. Tests use the minimum, 4.
     */
    constructor({ rounds = 10 } = {}) {
        this.#rounds = rounds;
    }

    /**
     * @param {string} password
     * @returns {Promise<string>} The hash with its salt
     * @throws {RangeError} If the password is longer than 72 bytes: bcrypt
     *   would silently ignore the rest, so request schemas limit the length
     */
    async hash(password) {
        if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
            throw new RangeError(
                `A password must be at most ${MAX_PASSWORD_BYTES} bytes.`
            );
        }
        return bcrypt.hash(password, this.#rounds);
    }

    /**
     * @param {string} password
     * @param {string} hash As returned by {@link PasswordHasher#hash}
     * @returns {Promise<boolean>} Whether the password matches the hash
     */
    async verify(password, hash) {
        return bcrypt.compare(password, hash);
    }
}
