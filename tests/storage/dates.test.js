import { describe, test, expect } from 'vitest';
import {
    isDate,
    isDatetime,
    normalizeDatetime,
} from '../../src/storage/dates.js';

describe('isDate', () => {
    test.each(['2026-10-23', '2024-02-29', '2000-02-29', '0050-06-15'])(
        'accepts %s',
        (value) => {
            expect(isDate(value)).toBe(true);
        }
    );

    test.each([
        ['non-leap February 29', '2026-02-29'],
        ['century non-leap year', '1900-02-29'],
        ['day 31 of a 30-day month', '2026-04-31'],
        ['month 13', '2026-13-01'],
        ['day 0', '2026-10-00'],
        ['single-digit month', '2026-1-05'],
        ['with time', '2026-10-23T00:00:00Z'],
        ['other separator', '2026/10/23'],
        ['number', 20261023],
        ['null', null],
    ])('rejects %s', (_label, value) => {
        expect(isDate(value)).toBe(false);
    });
});

describe('normalizeDatetime', () => {
    test.each([
        [
            'UTC with milliseconds',
            '2026-10-23T09:41:12.000Z',
            '2026-10-23T09:41:12.000Z',
        ],
        [
            'UTC without seconds',
            '2026-10-23T09:41Z',
            '2026-10-23T09:41:00.000Z',
        ],
        [
            'positive offset',
            '2026-10-23T12:41:12+03:00',
            '2026-10-23T09:41:12.000Z',
        ],
        [
            'negative offset',
            '2026-10-23T05:41:12-04:00',
            '2026-10-23T09:41:12.000Z',
        ],
        [
            'offset crossing midnight',
            '2026-10-23T00:30:00+03:00',
            '2026-10-22T21:30:00.000Z',
        ],
        [
            'fractions are padded',
            '2026-10-23T09:41:12.5Z',
            '2026-10-23T09:41:12.500Z',
        ],
        [
            'fractions are cut to milliseconds',
            '2026-10-23T09:41:12.123456Z',
            '2026-10-23T09:41:12.123Z',
        ],
        ['leap day', '2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
        [
            'two-digit year stays',
            '0050-06-15T00:00:00Z',
            '0050-06-15T00:00:00.000Z',
        ],
    ])('%s', (_label, value, canonical) => {
        expect(normalizeDatetime(value)).toBe(canonical);
        expect(isDatetime(value)).toBe(true);
    });

    test.each([
        ['no offset: whose time would it be', '2026-10-23T12:41:12'],
        ['a day that does not exist', '2026-02-30T00:00:00Z'],
        ['hour 24', '2026-10-23T24:00:00Z'],
        ['minute 60', '2026-10-23T12:60:00Z'],
        ['second 60', '2026-10-23T12:00:60Z'],
        ['offset hours 24', '2026-10-23T12:00:00+24:00'],
        ['date only', '2026-10-23'],
        ['beyond year 9999 after the offset', '9999-12-31T23:00:00-02:00'],
        ['space instead of T', '2026-10-23 12:00:00Z'],
        ['number', 1792772385281],
    ])('rejects %s', (_label, value) => {
        expect(normalizeDatetime(value)).toBeNull();
        expect(isDatetime(value)).toBe(false);
    });

    test('canonical strings sort in time order', () => {
        const values = [
            '2026-10-23T12:00:00Z',
            '2026-10-23T12:00:00.5Z',
            '2026-10-23T14:00:00+03:00',
        ].map(normalizeDatetime);
        expect([...values].sort()).toEqual([values[2], values[0], values[1]]);
    });
});
