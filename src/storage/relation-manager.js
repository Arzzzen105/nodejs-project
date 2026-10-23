import { DatabaseError } from './errors.js';

/**
 * @typedef {object} Relation
 * @property {string} collection Collection that holds the reference column
 * @property {string} field Reference column name
 * @property {string} target Referenced collection
 * @property {'restrict'|'setNull'|'remove'} onDelete
 * @property {boolean} many True for array columns (`items.references`)
 */

/**
 * @typedef {object} ReferenceSource
 * Collection-like object the RelationManager reads from.
 * @property {(id: string) => boolean} has
 * @property {(field: string, id: string) => Set<string>} findReferrers
 * @property {(field: string) => Array<{ value: *, ids: Set<string> }>} referenceEntries
 */

/**
 * Extracts reference columns from a validated collection config.
 * @param {string} name Collection name
 * @param {object} config
 * @returns {Relation[]}
 */
export function collectRelations(name, config) {
    const relations = [];
    for (const [field, definition] of Object.entries(config.columns)) {
        const reference = definition.references ?? definition.items?.references;
        if (!reference) continue;
        relations.push({
            collection: name,
            field,
            target: reference.collection,
            onDelete: reference.onDelete ?? 'restrict',
            many: definition.type === 'array',
        });
    }
    return relations;
}

/**
 * Keeps the reference graph between collections and enforces referential integrity:
 * references must point to existing records, and deleting a referenced record
 * applies the `onDelete` rule of every incoming reference.
 */
export class RelationManager {
    #outgoing = new Map();
    #incoming = new Map();

    /**
     * @param {Map<string, object>} configs Validated configs by collection name
     */
    constructor(configs) {
        for (const name of configs.keys()) {
            this.#outgoing.set(name, []);
            this.#incoming.set(name, []);
        }
        for (const [name, config] of configs) {
            for (const relation of collectRelations(name, config)) {
                if (!configs.has(relation.target)) {
                    throw new DatabaseError(
                        `Invalid reference "${name}.${relation.field}": collection "${relation.target}" does not exist.`,
                        500,
                        'INVALID_CONFIG'
                    );
                }
                this.#outgoing.get(name).push(relation);
                this.#incoming.get(relation.target).push(relation);
            }
        }
    }

    /**
     * References declared by the collection.
     * @param {string} name
     * @returns {Relation[]}
     */
    outgoing(name) {
        return this.#outgoing.get(name) ?? [];
    }

    /**
     * References pointing to the collection.
     * @param {string} name
     * @returns {Relation[]}
     */
    incoming(name) {
        return this.#incoming.get(name) ?? [];
    }

    /**
     * Ensures every reference of the record points to an existing record.
     * @param {string} name
     * @param {object} record Normalized record
     * @param {(name: string) => ReferenceSource} resolve
     */
    validateReferences(name, record, resolve) {
        for (const { field, target, many } of this.outgoing(name)) {
            if (!Object.hasOwn(record, field) || record[field] === null) {
                continue;
            }
            const ids = many ? record[field] : [record[field]];
            if (many && new Set(ids).size !== ids.length) {
                throw new DatabaseError(
                    `"${field}" must not contain duplicate references.`,
                    422,
                    'VALIDATION_ERROR'
                );
            }
            for (const id of ids) {
                if (typeof id !== 'string' || !resolve(target).has(id)) {
                    throw new DatabaseError(
                        `"${field}" references a missing record in "${target}": ${JSON.stringify(id)}.`,
                        422,
                        'REFERENCE_NOT_FOUND'
                    );
                }
            }
        }
    }

    /**
     * Computes changes required to delete a record without leaving broken references.
     * Throws REFERENCE_RESTRICT if any `restrict` reference points to the record.
     * @param {string} name
     * @param {string} id
     * @param {(name: string) => ReferenceSource} resolve
     * @returns {Array<{ collection: string, id: string, setNull: string[], remove: string[] }>}
     */
    planDelete(name, id, resolve) {
        const changes = new Map();
        const blockers = [];

        for (const relation of this.incoming(name)) {
            const referrers = resolve(relation.collection).findReferrers(
                relation.field,
                id
            );
            // a record referencing itself disappears together with the reference
            if (relation.collection === name) referrers.delete(id);
            if (referrers.size === 0) continue;

            if (relation.onDelete === 'restrict') {
                blockers.push(
                    `${relation.collection}.${relation.field} (${referrers.size})`
                );
                continue;
            }

            for (const referrer of referrers) {
                const key = `${relation.collection}/${referrer}`;
                if (!changes.has(key)) {
                    changes.set(key, {
                        collection: relation.collection,
                        id: referrer,
                        setNull: [],
                        remove: [],
                    });
                }
                const change = changes.get(key);
                (relation.many ? change.remove : change.setNull).push(
                    relation.field
                );
            }
        }

        if (blockers.length > 0) {
            throw new DatabaseError(
                `Cannot delete ${name}/${id}: it is referenced by ${blockers.join(', ')}.`,
                409,
                'REFERENCE_RESTRICT'
            );
        }
        return [...changes.values()];
    }

    /**
     * Verifies that no stored reference points to a missing record.
     * @param {(name: string) => ReferenceSource} resolve
     */
    checkIntegrity(resolve) {
        const broken = [];
        for (const relations of this.#outgoing.values()) {
            for (const { collection, field, target } of relations) {
                const targetSource = resolve(target);
                for (const { value, ids } of resolve(
                    collection
                ).referenceEntries(field)) {
                    if (value === null) continue;
                    if (typeof value === 'string' && targetSource.has(value)) {
                        continue;
                    }
                    for (const id of ids) {
                        broken.push(
                            `${collection}/${id}.${field} -> ${target}/${JSON.stringify(value)}`
                        );
                    }
                }
            }
        }

        if (broken.length > 0) {
            const shown = broken.slice(0, 20);
            const more =
                broken.length > shown.length
                    ? `\n  ...and ${broken.length - shown.length} more`
                    : '';
            throw new DatabaseError(
                `Found ${broken.length} broken reference(s):\n  ${shown.join('\n  ')}${more}`,
                500,
                'BROKEN_REFERENCES'
            );
        }
    }
}
