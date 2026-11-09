import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import {
    createTeacher,
    updateTeacher,
} from '../../src/validators/teacher-schemas.js';
import { createTestApp } from '../helpers/test-app.js';

const CONFIG = path.resolve(
    import.meta.dirname,
    '../../database/teachers/config.json'
);

const VALID = { firstName: 'Олена', lastName: 'Ткаченко' };

describe('teacher schemas', () => {
    test('createTeacher has exactly the columns of the collection', async () => {
        const { columns } = JSON.parse(await fs.readFile(CONFIG, 'utf8'));

        expect(Object.keys(createTeacher.shape).sort()).toEqual(
            Object.keys(columns).sort()
        );
    });

    test('updateTeacher accepts any part of the fields and adds nothing', () => {
        expect(updateTeacher.parse({})).toEqual({});
        expect(updateTeacher.parse({ subjectIds: [] })).toEqual({
            subjectIds: [],
        });
    });

    test.each([['id'], ['createdAt'], ['updatedAt'], ['unknown']])(
        'rejects "%s", which the client cannot set',
        (field) => {
            const body = { ...VALID, [field]: 'x' };

            expect(createTeacher.safeParse(body).success).toBe(false);
            expect(updateTeacher.safeParse({ [field]: 'x' }).success).toBe(
                false
            );
        }
    );

    describe('agrees with the database', () => {
        let repositories;
        let close;
        let music;
        let drawing;

        beforeEach(async () => {
            const testApp = await createTestApp();
            repositories = testApp.container.repositories;
            close = testApp.close;
            music = await repositories.subjects.create({ name: 'Музика' });
            drawing = await repositories.subjects.create({
                name: 'Малювання',
            });
        });

        afterEach(async () => close());

        /** Whether the database stores the record, past the service rules. */
        const databaseAccepts = (body) =>
            repositories.teachers.create(body).then(
                () => true,
                () => false
            );

        const without = (field) => {
            const body = { ...VALID };
            delete body[field];
            return body;
        };

        // the subjects exist only once the database is created
        test.each([
            ['valid teacher', () => VALID],
            ['no firstName', () => without('firstName')],
            ['no lastName', () => without('lastName')],
            ['empty firstName', () => ({ ...VALID, firstName: '' })],
            [
                'firstName of 101',
                () => ({ ...VALID, firstName: 'x'.repeat(101) }),
            ],
            [
                'lastName of 100',
                () => ({ ...VALID, lastName: 'x'.repeat(100) }),
            ],
            ['no subjects', () => ({ ...VALID, subjectIds: [] })],
            ['one subject', () => ({ ...VALID, subjectIds: [music.id] })],
            [
                'two subjects',
                () => ({ ...VALID, subjectIds: [music.id, drawing.id] }),
            ],
            [
                'the same subject twice',
                () => ({ ...VALID, subjectIds: [music.id, music.id] }),
            ],
            ['subjectIds null', () => ({ ...VALID, subjectIds: null })],
            [
                'subjectIds not an array',
                () => ({ ...VALID, subjectIds: music.id }),
            ],
            ['subject not a string', () => ({ ...VALID, subjectIds: [1] })],
            ['subject not a UUID', () => ({ ...VALID, subjectIds: ['abc'] })],
        ])('%s', async (name, makeBody) => {
            const body = makeBody();

            expect(createTeacher.safeParse(body).success).toBe(
                await databaseAccepts(body)
            );
        });
    });

    test('rejects a subject id that is not a UUIDv7', () => {
        const result = createTeacher.safeParse({
            ...VALID,
            subjectIds: [uuidv4()],
        });

        expect(result.success).toBe(false);
        expect(result.error.issues[0].path).toEqual(['subjectIds', 0]);
    });
});
