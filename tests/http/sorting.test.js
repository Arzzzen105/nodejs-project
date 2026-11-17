import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';

// FR-023: lists come in the order people were entered or in alphabetical order
describe('sorting of lists (FR-023)', () => {
    let app;
    let close;

    beforeEach(async () => {
        ({ app, close } = await createTestApp());
    });

    afterEach(async () => close());

    /** Creates educators one by one, in the order given. */
    const enter = async (...names) => {
        for (const [lastName, firstName = 'Anna'] of names) {
            await request(app)
                .post('/api/educators')
                .send({ firstName, lastName })
                .expect(201);
        }
    };
    const listed = async (query) =>
        (
            await request(app).get('/api/educators').query(query).expect(200)
        ).body.items.map(({ lastName, firstName }) =>
            firstName === 'Anna' ? lastName : `${lastName} ${firstName}`
        );

    describe('by the order of entry', () => {
        beforeEach(async () => enter(['Smith'], ['adams'], ['Іваненко']));

        test.each([
            ['without sort', {}],
            ['by id', { sort: 'id' }],
            ['by createdAt', { sort: 'createdAt' }],
        ])('%s', async (name, query) => {
            expect(await listed(query)).toEqual(['Smith', 'adams', 'Іваненко']);
        });

        test('the latest first with -id', async () => {
            expect(await listed({ sort: '-id' })).toEqual([
                'Іваненко',
                'adams',
                'Smith',
            ]);
        });
    });

    describe('in alphabetical order', () => {
        test('does not split the order by case', async () => {
            await enter(['carter'], ['Baker'], ['adams'], ['Davis']);

            expect(await listed({ sort: 'lastName' })).toEqual([
                'adams',
                'Baker',
                'carter',
                'Davis',
            ]);
        });

        test('orders by the first name when the last names are the same', async () => {
            await enter(['Smith', 'John'], ['Brown', 'Ann'], ['Smith', 'adam']);

            expect(await listed({ sort: 'lastName,firstName' })).toEqual([
                'Brown Ann',
                'Smith adam',
                'Smith John',
            ]);
        });

        test('skips the apostrophe', async () => {
            await enter(['Ochoa'], ["O'Brien"], ['Obama']);

            expect(await listed({ sort: 'lastName' })).toEqual([
                'Obama',
                "O'Brien",
                'Ochoa',
            ]);
        });

        test('puts Ukrainian letters in their places', async () => {
            await enter(
                ['Яковенко'],
                ['Іваненко'],
                ['Ґудзенко'],
                ['Гнатюк'],
                ["Мар'яненко"],
                ['Марченко']
            );

            expect(await listed({ sort: 'lastName' })).toEqual([
                'Гнатюк',
                'Ґудзенко',
                'Іваненко',
                'Марченко',
                "Мар'яненко",
                'Яковенко',
            ]);
        });

        test('from Z to A with a minus', async () => {
            await enter(['Baker'], ['adams'], ['carter']);

            expect(await listed({ sort: '-lastName' })).toEqual([
                'carter',
                'Baker',
                'adams',
            ]);
        });
    });
});
