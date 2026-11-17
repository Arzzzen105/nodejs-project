import { describe, test, expect } from 'vitest';
import { compareText } from '../../src/storage/collation.js';

const sorted = (values) => [...values].sort(compareText);

describe('compareText', () => {
    test('does not split the order by case', () => {
        expect(sorted(['carter', 'Baker', 'adams'])).toEqual([
            'adams',
            'Baker',
            'carter',
        ]);
    });

    test('puts Ukrainian letters in alphabetical order', () => {
        expect(
            sorted([
                'Яковенко',
                'Їжак',
                'Іваненко',
                'Єрмак',
                'Ґудзенко',
                'Гнатюк',
            ])
        ).toEqual([
            'Гнатюк',
            'Ґудзенко',
            'Єрмак',
            'Іваненко',
            'Їжак',
            'Яковенко',
        ]);
    });

    test('compares digits as numbers', () => {
        expect(sorted(['Група 10', 'Група 2', 'Група 1'])).toEqual([
            'Група 1',
            'Група 2',
            'Група 10',
        ]);
    });

    test.each([
        [
            'Ukrainian',
            ["Мар'яна", 'Марія', 'Марина'],
            ['Марина', 'Марія', "Мар'яна"],
        ],
        [
            'English',
            ["O'Brien", 'Ochoa', 'Obama'],
            ['Obama', "O'Brien", 'Ochoa'],
        ],
    ])('skips the apostrophe in %s', (name, values, expected) => {
        expect(sorted(values)).toEqual(expected);
    });

    test.each([
        ['typewriter', "Мар'яна"],
        ['typographic', 'Мар’яна'],
        ['modifier letter', 'Марʼяна'],
    ])('skips the %s apostrophe', (name, value) => {
        expect(compareText(value, 'Марія')).toBeGreaterThan(0);
        expect(compareText(value, 'Марянка')).toBeLessThan(0);
    });

    test('keeps spaces and hyphens: a name alone comes before its longer forms', () => {
        expect(
            sorted([
                'Петренков',
                'Петренко-Коваль',
                'Петренко Анна',
                'Петренко',
            ])
        ).toEqual([
            'Петренко',
            'Петренко Анна',
            'Петренко-Коваль',
            'Петренков',
        ]);
    });

    test('only equal text is equal: the order stays strict', () => {
        expect(compareText('Маряна', 'Маряна')).toBe(0);
        expect(compareText("Мар'яна", 'Маряна')).not.toBe(0);
        expect(Math.sign(compareText("Мар'яна", 'Маряна'))).toBe(
            -Math.sign(compareText('Маряна', "Мар'яна"))
        );
        expect(compareText('Adams', 'adams')).not.toBe(0);
    });
});
