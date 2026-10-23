import { describe, test, expect } from 'vitest';
import { IndexManager } from '../../src/storage/index-manager.js';
import { lockKey } from '../../src/storage/lock-manager.js';
import {
    RelationManager,
    collectRelations,
} from '../../src/storage/relation-manager.js';

function collectionConfig(name, columns = {}) {
    return { table: name, primaryKey: 'id', columns, indexes: [] };
}

const CONFIGS = new Map([
    ['owners', collectionConfig('owners', { name: { type: 'string' } })],
    ['tags', collectionConfig('tags', { label: { type: 'string' } })],
    [
        'items',
        collectionConfig('items', {
            title: { type: 'string' },
            ownerId: {
                type: 'string',
                nullable: true,
                references: { collection: 'owners', onDelete: 'setNull' },
            },
            tagIds: {
                type: 'array',
                items: {
                    references: { collection: 'tags', onDelete: 'remove' },
                },
            },
        }),
    ],
    [
        'notes',
        collectionConfig('notes', {
            itemId: { type: 'string', references: { collection: 'items' } },
        }),
    ],
    [
        'nodes',
        collectionConfig('nodes', {
            parentId: {
                type: 'string',
                nullable: true,
                references: { collection: 'nodes', onDelete: 'setNull' },
            },
        }),
    ],
]);

/**
 * Builds in-memory ReferenceSources indexed the same way Collection indexes references.
 * @param {Record<string, object[]>} data Records by collection name
 */
function createResolver(data) {
    const sources = new Map();
    for (const [name, config] of CONFIGS) {
        const relations = collectRelations(name, config);
        const indexes = new IndexManager(
            relations.filter((r) => !r.many).map((r) => r.field),
            relations.filter((r) => r.many).map((r) => r.field)
        );
        const records = data[name] ?? [];
        records.forEach((r) => indexes.indexRecord(r));
        const ids = new Set(records.map((r) => r.id));
        sources.set(name, {
            has: (id) => ids.has(id),
            findReferrers: (field, id) =>
                indexes.hasElementIndex(field)
                    ? indexes.lookupElement(field, id)
                    : indexes.lookup(field, id),
            referenceEntries: (field) => indexes.entries(field),
        });
    }
    return (name) => sources.get(name);
}

const DATA = {
    owners: [{ id: 'o1' }, { id: 'o2' }],
    tags: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
    items: [
        { id: 'i1', ownerId: 'o1', tagIds: ['t1', 't2'] },
        { id: 'i2', ownerId: 'o1', tagIds: ['t2'] },
        { id: 'i3', ownerId: null, tagIds: [] },
    ],
    notes: [{ id: 'n1', itemId: 'i1' }],
    nodes: [
        { id: 'root', parentId: null },
        { id: 'child', parentId: 'root' },
        { id: 'self', parentId: 'self' },
    ],
};

describe('collectRelations', () => {
    test('extracts scalar and array references with defaults', () => {
        expect(collectRelations('items', CONFIGS.get('items'))).toEqual([
            {
                collection: 'items',
                field: 'ownerId',
                target: 'owners',
                onDelete: 'setNull',
                many: false,
            },
            {
                collection: 'items',
                field: 'tagIds',
                target: 'tags',
                onDelete: 'remove',
                many: true,
            },
        ]);
        expect(
            collectRelations('notes', CONFIGS.get('notes'))[0].onDelete
        ).toBe('restrict');
    });

    test('returns nothing for collections without references', () => {
        expect(collectRelations('owners', CONFIGS.get('owners'))).toEqual([]);
    });
});

describe('RelationManager', () => {
    const relations = new RelationManager(CONFIGS);
    const resolve = createResolver(DATA);

    describe('graph', () => {
        test('outgoing and incoming relations', () => {
            expect(relations.outgoing('items').map((r) => r.field)).toEqual([
                'ownerId',
                'tagIds',
            ]);
            expect(
                relations.incoming('items').map((r) => r.collection)
            ).toEqual(['notes']);
            expect(relations.incoming('owners')).toHaveLength(1);
            expect(relations.outgoing('owners')).toEqual([]);
            expect(relations.incoming('unknown')).toEqual([]);
        });

        test('self references appear on both sides', () => {
            expect(relations.outgoing('nodes')).toEqual(
                relations.incoming('nodes')
            );
        });

        test('rejects references to unknown collections', () => {
            const configs = new Map([
                [
                    'items',
                    collectionConfig('items', {
                        ownerId: {
                            type: 'string',
                            references: { collection: 'ghosts' },
                        },
                    }),
                ],
            ]);
            expect(() => new RelationManager(configs)).toThrow(
                expect.objectContaining({
                    code: 'INVALID_CONFIG',
                    message: expect.stringMatching(
                        /"items.ownerId".*"ghosts" does not exist/
                    ),
                })
            );
        });
    });

    describe('validateReferences', () => {
        const validate = (record) =>
            relations.validateReferences('items', record, resolve);

        test('accepts existing references, null and missing fields', () => {
            expect(() =>
                validate({ ownerId: 'o2', tagIds: ['t1', 't3'] })
            ).not.toThrow();
            expect(() => validate({ ownerId: null, tagIds: [] })).not.toThrow();
            expect(() => validate({ title: 'no refs' })).not.toThrow();
        });

        test('rejects a missing scalar target', () => {
            expect(() => validate({ ownerId: 'o9' })).toThrow(
                expect.objectContaining({
                    code: 'REFERENCE_NOT_FOUND',
                    status: 422,
                    message: expect.stringMatching(
                        /"ownerId" references a missing record in "owners": "o9"/
                    ),
                })
            );
        });

        test('rejects a missing array element', () => {
            expect(() => validate({ tagIds: ['t1', 't9'] })).toThrow(
                /"tagIds" references a missing record in "tags": "t9"/
            );
        });

        test('rejects non-string references', () => {
            expect(() => validate({ tagIds: [1] })).toThrow(
                expect.objectContaining({ code: 'REFERENCE_NOT_FOUND' })
            );
        });

        test('rejects duplicate array references', () => {
            expect(() => validate({ tagIds: ['t1', 't1'] })).toThrow(
                expect.objectContaining({
                    code: 'VALIDATION_ERROR',
                    message: expect.stringMatching(/duplicate references/),
                })
            );
        });

        test('accepts a self reference to an existing record', () => {
            expect(() =>
                relations.validateReferences(
                    'nodes',
                    { parentId: 'root' },
                    resolve
                )
            ).not.toThrow();
        });
    });

    describe('lock keys', () => {
        test('targetLockKeys collects referenced records from raw input', () => {
            expect(
                relations.targetLockKeys('items', {
                    ownerId: 'o1',
                    tagIds: ['t1', 't2'],
                    title: 'x',
                })
            ).toEqual([
                lockKey('owners', 'o1'),
                lockKey('tags', 't1'),
                lockKey('tags', 't2'),
            ]);
        });

        test('targetLockKeys ignores non-string values and bad input', () => {
            expect(
                relations.targetLockKeys('items', {
                    ownerId: null,
                    tagIds: [1],
                })
            ).toEqual([]);
            expect(relations.targetLockKeys('items', null)).toEqual([]);
            expect(relations.targetLockKeys('items', 'text')).toEqual([]);
        });

        test('referrerLockKeys collects records pointing to the target', () => {
            expect(
                relations.referrerLockKeys('owners', 'o1', resolve).sort()
            ).toEqual([lockKey('items', 'i1'), lockKey('items', 'i2')]);
            expect(relations.referrerLockKeys('tags', 't3', resolve)).toEqual(
                []
            );
        });
    });

    describe('planDelete', () => {
        test('setNull references are nulled', () => {
            expect(relations.planDelete('owners', 'o1', resolve)).toEqual([
                {
                    collection: 'items',
                    id: 'i1',
                    setNull: ['ownerId'],
                    remove: [],
                },
                {
                    collection: 'items',
                    id: 'i2',
                    setNull: ['ownerId'],
                    remove: [],
                },
            ]);
        });

        test('remove references are pulled from arrays', () => {
            expect(relations.planDelete('tags', 't2', resolve)).toEqual([
                {
                    collection: 'items',
                    id: 'i1',
                    setNull: [],
                    remove: ['tagIds'],
                },
                {
                    collection: 'items',
                    id: 'i2',
                    setNull: [],
                    remove: ['tagIds'],
                },
            ]);
        });

        test('unreferenced records need no changes', () => {
            expect(relations.planDelete('tags', 't3', resolve)).toEqual([]);
            expect(relations.planDelete('owners', 'o2', resolve)).toEqual([]);
        });

        test('restrict references block the delete', () => {
            expect(() => relations.planDelete('items', 'i1', resolve)).toThrow(
                expect.objectContaining({
                    code: 'REFERENCE_RESTRICT',
                    status: 409,
                    message: expect.stringMatching(
                        /Cannot delete items\/i1: it is referenced by notes.itemId \(1\)/
                    ),
                })
            );
        });

        test('restrict does not block unreferenced records', () => {
            expect(relations.planDelete('items', 'i3', resolve)).toEqual([]);
        });

        test('self references: children are nulled, the record itself is skipped', () => {
            expect(relations.planDelete('nodes', 'root', resolve)).toEqual([
                {
                    collection: 'nodes',
                    id: 'child',
                    setNull: ['parentId'],
                    remove: [],
                },
            ]);
            expect(relations.planDelete('nodes', 'self', resolve)).toEqual([]);
        });

        test('several fields of one record are merged into one change', () => {
            const configs = new Map([
                ['people', collectionConfig('people')],
                [
                    'pairs',
                    collectionConfig('pairs', {
                        leftId: {
                            type: 'string',
                            nullable: true,
                            references: {
                                collection: 'people',
                                onDelete: 'setNull',
                            },
                        },
                        rightId: {
                            type: 'string',
                            nullable: true,
                            references: {
                                collection: 'people',
                                onDelete: 'setNull',
                            },
                        },
                    }),
                ],
            ]);
            const manager = new RelationManager(configs);
            const indexes = new IndexManager(['leftId', 'rightId']);
            indexes.indexRecord({ id: 'p1', leftId: 'x', rightId: 'x' });
            const local = (name) => ({
                has: () => true,
                findReferrers: (field, id) =>
                    name === 'pairs' ? indexes.lookup(field, id) : new Set(),
            });

            expect(manager.planDelete('people', 'x', local)).toEqual([
                {
                    collection: 'pairs',
                    id: 'p1',
                    setNull: ['leftId', 'rightId'],
                    remove: [],
                },
            ]);
        });
    });

    describe('checkIntegrity', () => {
        test('passes for consistent data', () => {
            expect(() => relations.checkIntegrity(resolve)).not.toThrow();
        });

        test('reports every broken reference', () => {
            const broken = createResolver({
                ...DATA,
                owners: [{ id: 'o2' }],
                items: [
                    { id: 'i1', ownerId: 'o1', tagIds: ['t1', 'gone'] },
                    { id: 'i2', ownerId: 'o1', tagIds: [] },
                ],
                notes: [],
            });

            expect(() => relations.checkIntegrity(broken)).toThrow(
                expect.objectContaining({ code: 'BROKEN_REFERENCES' })
            );
            try {
                relations.checkIntegrity(broken);
            } catch (error) {
                expect(error.message).toMatch(/Found 3 broken reference/);
                expect(error.message).toContain(
                    'items/i1.ownerId -> owners/"o1"'
                );
                expect(error.message).toContain(
                    'items/i2.ownerId -> owners/"o1"'
                );
                expect(error.message).toContain(
                    'items/i1.tagIds -> tags/"gone"'
                );
            }
        });

        test('reports non-string reference values', () => {
            const broken = createResolver({
                ...DATA,
                notes: [{ id: 'n1', itemId: 5 }],
            });
            expect(() => relations.checkIntegrity(broken)).toThrow(
                /notes\/n1.itemId -> items\/5/
            );
        });

        test('truncates long reports', () => {
            const notes = Array.from({ length: 25 }, (_, i) => ({
                id: `n${i}`,
                itemId: 'gone',
            }));
            const broken = createResolver({ ...DATA, notes });
            expect(() => relations.checkIntegrity(broken)).toThrow(
                /\.\.\.and 5 more/
            );
        });
    });
});
