import { v7 as uuidv7 } from 'uuid';

/**
 * Builds a version 2 journal entry from changes in the shape the journal
 * applies, `{ collection, id, record }`, for tests that write a journal by hand.
 * @param {Array<{ collection: string, id: string, record: object|null }>} changes
 * @returns {import('../../src/storage/journal.js').CommitEntry}
 */
export function commitOf(changes) {
    return {
        tx: uuidv7(),
        at: new Date().toISOString(),
        context: null,
        changes: changes.map(({ collection, id, record }) => ({
            collection,
            id,
            after: record,
        })),
    };
}
