import { StatusCodes } from 'http-status-codes';
import { HttpError, forbidden } from '../http-error.js';
import { PERSON_FIELD, PERSON_FIELDS, ROLES } from '../security/roles.js';

/**
 * @typedef {import('../repositories/unit-of-work.js').UnitOfWork} UnitOfWork
 * @typedef {import('../repositories/user-repository.js').UserRepository} UserRepository
 * @typedef {import('../security/password-hasher.js').PasswordHasher} PasswordHasher
 */

/**
 * The account as the API shows it: everything but the password hash.
 * @param {object} user A stored account
 * @returns {object}
 */
export function publicUser(user) {
    const shown = { ...user };
    delete shown.passwordHash;
    return shown;
}

/**
 * Use cases for user accounts (EPIC-03). Accounts hold only login data and
 * the link to the person they belong to; contacts stay in the person's record.
 *
 * Rules:
 * - the password is stored only as a hash, which is never returned;
 * - an account of an educator, a teacher or a parent links to exactly that
 *   person, and accounts of the admin and the manager link to no one;
 * - the username and the password cannot be changed (BR-67), so there is no
 *   update;
 * - the admin registers and deletes any account (BR-64), the manager any but
 *   those of the admin and the manager (BR-65);
 * - nobody deletes their own account, so the last admin always stays.
 *
 * Writes take the `actor`, the account making the request. Without one the
 * call is made by the system itself (startup, scripts, tests) and only the
 * rules of the data apply.
 */
export class UserService {
    #uow;
    #users;
    #passwords;

    /**
     * @param {object} dependencies
     * @param {UnitOfWork} dependencies.uow
     * @param {UserRepository} dependencies.users
     * @param {PasswordHasher} dependencies.passwords
     */
    constructor({ uow, users, passwords }) {
        this.#uow = uow;
        this.#users = users;
        this.#passwords = passwords;
    }

    /** @see BaseRepository#findPage */
    async list(query) {
        const page = await this.#users.findPage(query);
        return { ...page, items: page.items.map(publicUser) };
    }

    /** @see BaseRepository#findById */
    async find(id) {
        const user = await this.#users.findById(id);
        return user && publicUser(user);
    }

    /** @see BaseRepository#getById */
    async get(id) {
        return publicUser(await this.#users.getById(id));
    }

    /**
     * Registers an account; the actor sets its username and password
     * (BR-66).
     * @param {object} data
     * @param {string} data.username
     * @param {string} data.password Plain text; only its hash is stored
     * @param {string} data.role One of ROLES
     * @param {string|null} [data.parentId]
     * @param {string|null} [data.educatorId]
     * @param {string|null} [data.teacherId]
     * @param {{ id: string, role: string }} [actor]
     * @returns {Promise<object>} The account without its password hash
     * @throws {HttpError} 403 FORBIDDEN if the actor may not register this
     *   role, 422 USER_PERSON_MISMATCH; errors of the database:
     *   409 UNIQUE_VIOLATION for a taken username or a person who already has
     *   an account, 422 REFERENCE_NOT_FOUND for a missing person
     */
    async create({ password, ...data }, actor) {
        if (actor && !canManage(actor, data.role)) {
            throw forbidden(
                `A ${actor.role} cannot register a ${data.role} account.`
            );
        }
        assertPersonOfRole(data);
        const passwordHash = await this.#passwords.hash(password);
        return publicUser(await this.#users.create({ ...data, passwordHash }));
    }

    /**
     * @see BaseRepository#delete
     * @param {string} id UUIDv7
     * @param {{ id: string, role: string }} [actor]
     * @throws {HttpError} 404 NOT_FOUND, 409 CANNOT_DELETE_SELF, 403
     *   FORBIDDEN if the actor may not delete an account of this role
     */
    async delete(id, actor) {
        return this.#uow.run(async () => {
            const user = await this.#users.getById(id);
            if (actor?.id === id) {
                throw new HttpError(
                    StatusCodes.CONFLICT,
                    'CANNOT_DELETE_SELF',
                    'You cannot delete your own account.'
                );
            }
            if (actor && !canManage(actor, user.role)) {
                throw forbidden(
                    `A ${actor.role} cannot delete a ${user.role} account.`
                );
            }
            return this.#users.delete(id);
        });
    }
}

/**
 * @param {object} data Fields of a new account
 * @throws {HttpError} 422 USER_PERSON_MISMATCH unless the account links to
 *   the person of its role, and only to them
 */
function assertPersonOfRole(data) {
    const expected = PERSON_FIELD[data.role];
    const given = PERSON_FIELDS.filter((field) => data[field] != null);
    if (given.length === (expected ? 1 : 0) && (!expected || data[expected])) {
        return;
    }
    throw new HttpError(
        StatusCodes.UNPROCESSABLE_ENTITY,
        'USER_PERSON_MISMATCH',
        expected
            ? `A ${data.role} account must have "${expected}" and no other person.`
            : `A ${data.role} account must not be linked to a person.`
    );
}

/**
 * Whether an actor registers and deletes accounts of a role (BR-64, BR-65).
 * @param {{ role: string }} actor
 * @param {string} role
 * @returns {boolean}
 */
function canManage(actor, role) {
    if (actor.role === ROLES.ADMIN) return true;
    if (actor.role === ROLES.MANAGER) {
        return role !== ROLES.ADMIN && role !== ROLES.MANAGER;
    }
    return false;
}
