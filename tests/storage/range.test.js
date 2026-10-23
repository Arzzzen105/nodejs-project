import { describe, test, expect } from 'vitest';
import { matchesRange } from '../../src/storage/range.js';

describe('matchesRange', () => {
    test('respects inclusive and exclusive bounds', () => {
        expect(matchesRange(5, { gt: 5 })).toBe(false);
        expect(matchesRange(5, { gte: 5 })).toBe(true);
        expect(matchesRange(5, { lt: 5 })).toBe(false);
        expect(matchesRange(5, { lte: 5 })).toBe(true);
        expect(matchesRange(5, { gt: 1, lt: 10 })).toBe(true);
    });

    test('empty bounds match any orderable value', () => {
        expect(matchesRange(0, {})).toBe(true);
        expect(matchesRange('', {})).toBe(true);
    });

    test('compares strings lexicographically', () => {
        expect(matchesRange('b', { gt: 'a', lt: 'c' })).toBe(true);
        expect(matchesRange('10', { lt: '9' })).toBe(true);
    });

    test.each([
        ['null', null],
        ['undefined', undefined],
        ['boolean', false],
        ['object', {}],
        ['array', []],
    ])('%s never matches', (_label, value) => {
        expect(matchesRange(value, { lt: 10 })).toBe(false);
        expect(matchesRange(value, {})).toBe(false);
    });

    test('does not coerce between numbers and strings', () => {
        expect(matchesRange('5', { lt: 10 })).toBe(false);
        expect(matchesRange(5, { lt: '10' })).toBe(false);
        expect(matchesRange(5, { gt: 1, lt: '10' })).toBe(false);
    });

    test('null bound matches nothing', () => {
        expect(matchesRange(0, { lt: null })).toBe(false);
        expect(matchesRange(0, { gte: null })).toBe(false);
    });
});
