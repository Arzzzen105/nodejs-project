import { isDeepStrictEqual } from 'node:util';
import { StatusCodes } from 'http-status-codes';
import { HttpError } from '../http-error.js';

/**
 * @typedef {import('../repositories/change-repository.js').ChangeRepository} ChangeRepository
 * @typedef {import('../repositories/user-repository.js').UserRepository} UserRepository
 */

/** Fields of every record that change on their own: not what a user changed. */
const TIMESTAMPS = new Set(['createdAt', 'updatedAt']);

/** Never shown, even to the admin. */
const SECRET = 'passwordHash';

/**
 * The history of changes (FR-15): who changed which record, when, how, and
 * what it was before and after. The database records every commit; this
 * reads it, newest first, one item for each change of a record. Changes made
 * by the rules of `onDelete` share the transaction (`tx`) of the delete.
 *
 * The history holds whole records, personal data included, so the router
 * lets only the admin in. Hashes of passwords are left out.
 */
export class ChangeService {
    #changes;
    #users;

    /**
     * @param {object} dependencies
     * @param {ChangeRepository} dependencies.changes
     * @param {UserRepository} dependencies.users Who made a change
     */
    constructor({ changes, users }) {
        this.#changes = changes;
        this.#users = users;
    }

    /**
     * A page of changes, newest first.
     * @param {object} [query]
     * @param {string} [query.collection] Of one collection
     * @param {string} [query.id] Of one record
     * @param {string} [query.userId] Made by one account
     * @param {'create'|'update'|'delete'} [query.op]
     * @param {string} [query.from] ISO 8601 with an offset, included
     * @param {string} [query.to] Not included
     * @param {number} [query.limit=50]
     * @param {number} [query.offset=0]
     * @returns {Promise<{ items: object[], total: number, limit: number, offset: number }>}
     * @throws {HttpError} 400 INVALID_QUERY for an unknown collection
     */
    async list({
        collection,
        id,
        userId,
        op,
        from,
        to,
        limit = 50,
        offset = 0,
    } = {}) {
        if (collection && !this.#changes.collections().includes(collection)) {
            throw new HttpError(
                StatusCodes.BAD_REQUEST,
                'INVALID_QUERY',
                `There is no collection "${collection}".`
            );
        }
        const start = from ? Date.parse(from) : -Infinity;
        const end = to ? Date.parse(to) : Infinity;
        const entries = await this.#changes.findAll({
            since: from && utcDay(start),
            until: to && utcDay(end),
        });

        const matches = [];
        for (const entry of entries.reverse()) {
            const at = Date.parse(entry.at);
            if (at < start || at >= end) continue;
            if (userId && entry.context?.userId !== userId) continue;
            for (const change of entry.changes) {
                if (collection && change.collection !== collection) continue;
                if (id && change.id !== id) continue;
                if (op && change.op !== op) continue;
                matches.push({ entry, change });
            }
        }

        const page = matches.slice(offset, offset + limit);
        const users = await this.#accounts(page);
        return {
            items: page.map(({ entry, change }) =>
                describe(entry, change, users)
            ),
            total: matches.length,
            limit,
            offset,
        };
    }

    /**
     * The accounts that made the changes of a page, as they are now.
     * @returns {Promise<Map<string, object|null>>} By id; null if deleted
     */
    async #accounts(page) {
        const ids = new Set(
            page.map(({ entry }) => entry.context?.userId).filter(Boolean)
        );
        const users = new Map();
        for (const userId of ids) {
            const user = await this.#users.findById(userId);
            users.set(
                userId,
                user && {
                    id: user.id,
                    username: user.username,
                    role: user.role,
                }
            );
        }
        return users;
    }
}

/**
 * One change of a record as the API shows it.
 */
function describe(entry, change, users) {
    const before = shown(change.before);
    const after = shown(change.after);
    const userId = entry.context?.userId ?? null;
    return {
        tx: entry.tx,
        at: entry.at,
        collection: change.collection,
        id: change.id,
        op: change.op,
        changedFields: changedFields(before, after),
        before,
        after,
        userId,
        user: userId ? (users.get(userId) ?? null) : null,
        requestId: entry.context?.requestId ?? null,
    };
}

/**
 * @param {object|null} before
 * @param {object|null} after
 * @returns {string[]} Fields whose value differs, but the id and the
 *   timestamps; for a created or deleted record, the fields it had
 */
function changedFields(before, after) {
    const fields = new Set([
        ...Object.keys(before ?? {}),
        ...Object.keys(after ?? {}),
    ]);
    return [...fields].filter(
        (field) =>
            field !== 'id' &&
            !TIMESTAMPS.has(field) &&
            !isDeepStrictEqual(before?.[field], after?.[field])
    );
}

/** A record without its secret. */
function shown(record) {
    if (!record || !(SECRET in record)) return record;
    const copy = { ...record };
    delete copy[SECRET];
    return copy;
}

/**
 * @param {number} time Milliseconds
 * @returns {string} The UTC day, `YYYY-MM-DD`: the files of the history are by it
 */
function utcDay(time) {
    return new Date(time).toISOString().slice(0, 10);
}
