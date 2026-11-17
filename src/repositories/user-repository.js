import { BaseRepository } from './base-repository.js';

/**
 * User accounts (collection "users"). Records include `passwordHash`: hiding
 * it from the API is the job of the user service.
 */
export class UserRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'users');
    }

    /**
     * @param {string} username
     * @returns {Promise<object|null>} The account, or null if there is none
     */
    async findByUsername(username) {
        const [user] = await this.findAll({ where: { username } });
        return user ?? null;
    }

    /**
     * Deletes the accounts of a person. The database restricts deleting a
     * person who still has an account, so services that delete people call
     * this first, in the same transaction.
     * @param {object} person One link field, e.g. `{ parentId }`
     * @returns {Promise<Array<{ deleted: Array, updated: Array }>>} A report of
     *   each deleted account
     */
    async deleteByPerson(person) {
        const reports = [];
        for (const user of await this.findAll({ where: person })) {
            reports.push(await this.delete(user.id));
        }
        return reports;
    }
}
