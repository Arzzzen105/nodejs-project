import { describe, test, expect } from 'vitest';
import { compareText } from '../../src/storage/collation.js';
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

    test('compares strings by code point by default', () => {
        expect(matchesRange('b', { gt: 'a', lt: 'c' })).toBe(true);
        expect(matchesRange('10', { lt: '9' })).toBe(true);
        // ids, dates and datetimes rely on this
        expect(matchesRange('Ґ', { gt: 'Я' })).toBe(true);
    });

    describe('with compareText, strings compare as Ukrainian text', () => {
        test.each([
            // by code point Є, І, Ї come before А and Ґ after Я
            ['Ґудзенко', { gt: 'Г', lt: 'Д' }],
            ['Єременко', { gt: 'Е', lt: 'Ж' }],
            ['Іваненко', { gt: 'И', lt: 'Й' }],
            ['Їжак', { gt: 'И', lt: 'Й' }],
            ['Група 2', { lt: 'Група 10' }],
        ])('%s lies within %o', (value, bounds) => {
            expect(matchesRange(value, bounds, compareText)).toBe(true);
            expect(matchesRange(value, bounds)).toBe(false);
        });

        test('inclusive bounds still include equal text', () => {
            expect(
                matchesRange('Оля', { gte: 'Оля', lte: 'Оля' }, compareText)
            ).toBe(true);
            expect(matchesRange('Оля', { gt: 'Оля' }, compareText)).toBe(false);
        });

        test('numbers are not affected', () => {
            expect(matchesRange(10, { gt: 9 }, compareText)).toBe(true);
            expect(matchesRange(5, { lt: 5 }, compareText)).toBe(false);
            expect(matchesRange('5', { lt: 5 }, compareText)).toBe(false);
        });
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
