import { describe, test, expect } from 'vitest';
import { monthAt, monthMoments, monthOf } from '../../src/services/months.js';

describe('months', () => {
    describe('monthOf', () => {
        test.each([
            ['2026-11', 1, '2026-11-01', '2026-11-30'],
            ['2028-02', 1, '2028-02-01', '2028-02-29'],
            ['2026-12', 1, '2026-12-01', '2026-12-31'],
            ['2026-11', 12, '2026-11-01', '2027-10-31'],
            ['2026-01', 12, '2026-01-01', '2026-12-31'],
        ])('%s for %i months: %s – %s', (period, months, start, end) => {
            expect(monthOf(period, months)).toEqual({ start, end });
        });
    });

    describe('monthMoments: midnights in Kyiv', () => {
        test.each([
            [
                '2026-11',
                '2026-11-01T00:00:00+02:00',
                '2026-12-01T00:00:00+02:00',
            ],
            [
                '2026-12',
                '2026-12-01T00:00:00+02:00',
                '2027-01-01T00:00:00+02:00',
            ],
            // summer time begins on the last Sunday of March
            [
                '2026-03',
                '2026-03-01T00:00:00+02:00',
                '2026-04-01T00:00:00+03:00',
            ],
            [
                '2026-10',
                '2026-10-01T00:00:00+03:00',
                '2026-11-01T00:00:00+02:00',
            ],
        ])('%s: from %s to %s', (period, from, to) => {
            expect(monthMoments(period)).toEqual({ from, to });
        });
    });

    describe('monthAt', () => {
        test.each([
            // 23:30 of 31 October in UTC is already November in Kyiv
            ['2026-10-31T23:30:00Z', '2026-11'],
            ['2026-11-30T21:59:59Z', '2026-11'],
            ['2026-11-30T22:00:00Z', '2026-12'],
        ])('%s is in %s', (moment, month) => {
            expect(monthAt(new Date(moment))).toBe(month);
        });
    });
});
