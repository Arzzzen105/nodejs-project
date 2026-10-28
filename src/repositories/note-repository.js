import { BaseRepository } from './base-repository.js';

/**
 * Notes (collection "notes"). Named queries are added here as
 * services need them.
 */
export class NoteRepository extends BaseRepository {
    /**
     * @param {import('./unit-of-work.js').UnitOfWork} uow
     */
    constructor(uow) {
        super(uow, 'notes');
    }

    /**
     * Deletes every note about a kid, in one transaction. The database has no
     * cascade, and `notes.kidId` restricts deleting the kid while notes exist.
     * @param {string} kidId UUIDv7
     * @returns {Promise<import('../storage/transaction.js').DeleteReport[]>} One per note
     */
    async deleteByKid(kidId) {
        return this.uow.run(async () => {
            const notes = await this.findAll({ where: { kidId } });
            const reports = [];
            for (const note of notes) reports.push(await this.delete(note.id));
            return reports;
        });
    }
}
