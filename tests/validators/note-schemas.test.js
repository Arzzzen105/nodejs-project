import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createNote, updateNote } from '../../src/validators/note-schemas.js';
import { createTestApp } from '../helpers/test-app.js';

const CONFIG = path.resolve(
    import.meta.dirname,
    '../../database/notes/config.json'
);

const VALID = { text: 'Алергія на горіхи' };

describe('note schemas', () => {
    test('createNote has the columns of the collection but kidId, which is in the path', async () => {
        const { columns } = JSON.parse(await fs.readFile(CONFIG, 'utf8'));
        delete columns.kidId;

        expect(Object.keys(createNote.shape).sort()).toEqual(
            Object.keys(columns).sort()
        );
    });

    test('updateNote accepts any part of the fields and adds nothing', () => {
        expect(updateNote.parse({})).toEqual({});
        expect(updateNote.parse({ text: 'Інше' })).toEqual({ text: 'Інше' });
    });

    test.each([['id'], ['kidId'], ['createdAt'], ['updatedAt'], ['unknown']])(
        'rejects "%s", which the client cannot set',
        (field) => {
            const body = { ...VALID, [field]: 'x' };

            expect(createNote.safeParse(body).success).toBe(false);
            expect(updateNote.safeParse({ [field]: 'x' }).success).toBe(false);
        }
    );

    describe('agrees with the database', () => {
        let repositories;
        let close;
        let kid;

        beforeEach(async () => {
            const testApp = await createTestApp();
            repositories = testApp.container.repositories;
            close = testApp.close;
            kid = await repositories.kids.create({
                firstName: 'Марко',
                lastName: 'Коваль',
                age: 3,
                sex: 'MALE',
            });
        });

        afterEach(async () => close());

        /** Whether the database stores the note of the kid, past the service. */
        const databaseAccepts = (body) =>
            repositories.notes.create({ ...body, kidId: kid.id }).then(
                () => true,
                () => false
            );

        test.each([
            ['valid note', VALID],
            ['no text', {}],
            ['empty text', { text: '' }],
            ['text of 200', { text: 'x'.repeat(200) }],
            ['text of 201', { text: 'x'.repeat(201) }],
            ['text not a string', { text: 1 }],
            ['text null', { text: null }],
        ])('%s', async (name, body) => {
            expect(createNote.safeParse(body).success).toBe(
                await databaseAccepts(body)
            );
        });
    });
});
