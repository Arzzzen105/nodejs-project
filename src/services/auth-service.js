import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';
import { ROLES } from '../security/roles.js';
import { publicUser } from './user-service.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/user-repository.js').UserRepository} UserRepository
 * @typedef {import('../security/password-hasher.js').PasswordHasher} PasswordHasher
 * @typedef {import('../security/token-issuer.js').TokenIssuer} TokenIssuer
 */

/**
 * Logging in and recognizing the user of a request (EPIC-03).
 *
 * Rules:
 * - a wrong username and a wrong password are answered the same way, and
 *   take about as long, so the answer does not tell whether a username
 *   exists;
 * - a token is checked against the database on every request: the token of a
 *   deleted account stops working at once, and the role is the one stored
 *   now, not the one in the token.
 */
export class AuthService {
    #uow;
    #users;
    #passwords;
    #tokens;
    /** @type {Promise<string>|undefined} */
    #dummyHash;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {UserRepository} dependencies.users
     * @param {PasswordHasher} dependencies.passwords
     * @param {TokenIssuer} dependencies.tokens
     */
    constructor({ uow, users, passwords, tokens }) {
        this.#uow = uow;
        this.#users = users;
        this.#passwords = passwords;
        this.#tokens = tokens;
    }

    /**
     * @param {string} username
     * @param {string} password
     * @returns {Promise<{ token: string, expiresAt: string, user: object }>}
     * @throws {HttpError} 401 INVALID_CREDENTIALS
     */
    async login(username, password) {
        const user = await this.#users.findByUsername(username);
        // without an account a hash is still checked, so the time of the
        // answer does not tell whether the username exists
        const hash = user?.passwordHash ?? (await this.#dummy());
        const matches = await this.#passwords.verify(password, hash);
        if (!user || !matches) {
            throw new HttpError(
                StatusCodes.UNAUTHORIZED,
                'INVALID_CREDENTIALS',
                'The username or the password is wrong.'
            );
        }
        return { ...this.#tokens.issue(user), user: publicUser(user) };
    }

    /**
     * The user a token was issued to.
     * @param {string} token
     * @returns {Promise<object>} The account without its password hash
     * @throws {HttpError} 401 UNAUTHENTICATED if the token is invalid or
     *   expired, or its account was deleted
     */
    async authenticate(token) {
        let payload;
        try {
            payload = this.#tokens.verify(token);
        } catch {
            throw unauthenticated('The token is invalid or expired.');
        }
        const user = await this.#users.findById(payload.sub);
        if (!user) throw unauthenticated('The account no longer exists.');
        return publicUser(user);
    }

    /**
     * Creates the first admin when there are no accounts yet: nobody else
     * could register anyone. Does nothing once any account exists, so the
     * credentials are needed only for an empty database.
     * @param {{ username?: string, password?: string }} credentials
     * @returns {Promise<object|null>} The created admin, or null if accounts
     *   already exist
     * @throws {Error} If there are no accounts and no credentials; errors of
     *   the database for a username that breaks the rules of `users`
     */
    async ensureAdmin({ username, password }) {
        return this.#uow.run(async () => {
            if ((await this.#users.findPage({ limit: 1 })).total > 0) {
                return null;
            }
            if (!username || !password) {
                throw new Error(
                    'There are no accounts: a username and a password of the first admin are needed.'
                );
            }
            const passwordHash = await this.#passwords.hash(password);
            return publicUser(
                await this.#users.create({
                    username,
                    passwordHash,
                    role: ROLES.ADMIN,
                })
            );
        });
    }

    /** A hash of no real password, made once. */
    #dummy() {
        this.#dummyHash ??= this.#passwords.hash('no account has this');
        return this.#dummyHash;
    }
}

/**
 * @param {string} message
 * @returns {HttpError} 401 UNAUTHENTICATED
 */
export function unauthenticated(message) {
    return new HttpError(StatusCodes.UNAUTHORIZED, 'UNAUTHENTICATED', message);
}
