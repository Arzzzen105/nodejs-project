import { describe, test, expect } from 'vitest';
import { listQuery } from '../../src/validators/list-query.js';

describe('listQuery', () => {
    test('turns strings into values', () => {
        expect(
            listQuery.parse({
                where: '{"age":3}',
                sort: '-age',
                limit: '20',
                offset: '40',
            })
        ).toEqual({ where: { age: 3 }, sort: '-age', limit: 20, offset: 40 });
    });

    test('adds nothing to an empty query', () => {
        expect(listQuery.parse({})).toEqual({});
    });

    test('accepts several sort parameters', () => {
        expect(listQuery.parse({ sort: ['age', 'lastName'] }).sort).toEqual([
            'age',
            'lastName',
        ]);
    });

    test.each([
        ['broken JSON', { where: '{bad' }],
        ['JSON that is not an object: array', { where: '[1]' }],
        ['JSON that is not an object: null', { where: 'null' }],
        ['JSON that is not an object: number', { where: '3' }],
        ['where given twice', { where: ['{}', '{}'] }],
        ['limit that is not a number', { limit: 'abc' }],
        ['limit that is not whole', { limit: '1.5' }],
        ['unknown parameter', { limt: '5' }],
    ])('rejects %s', (name, query) => {
        expect(listQuery.safeParse(query).success).toBe(false);
    });
});
