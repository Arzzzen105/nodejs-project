import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { FileDatabase } from '../../src/storage/file-database.js';
import { createContainer } from '../../src/container.js';
import { PasswordHasher } from '../../src/security/password-hasher.js';
import { copySchema } from '../../scripts/copy-schema.js';
import { createTempDir, removeDir } from '../helpers/temp-db.js';

const SCHEMA = path.resolve(import.meta.dirname, '..', '..', 'database');

describe('UserService', () => {
    let root;
    let db;
    let services;
    let repositories;
    let users;

    beforeEach(async () => {
        root = await createTempDir();
        await copySchema(SCHEMA, root);
        db = await new FileDatabase(root).init();
        ({ services, repositories } = createContainer(db, {
            passwordRounds: 4,
        }));
        users = services.users;
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    const createParent = () =>
        repositories.parents.create({
            firstName: 'Olena',
            lastName: 'Koval',
            sex: 'FEMALE',
        });
    const createEducator = () =>
        repositories.educators.create({
            firstName: 'Iryna',
            lastName: 'Bondar',
        });
    const createTeacher = () =>
        repositories.teachers.create({
            firstName: 'Petro',
            lastName: 'Shevchuk',
        });

    /** People of each role that links to one, by their link field. */
    const people = async () => ({
        parentId: (await createParent()).id,
        educatorId: (await createEducator()).id,
        teacherId: (await createTeacher()).id,
    });

    const account = (fields = {}) => ({
        username: 'admin',
        password: 'correct horse',
        role: 'ADMIN',
        ...fields,
    });

    describe('create', () => {
        test('stores a hash of the password and never returns it', async () => {
            // ACT
            const created = await users.create(account());

            // ASSERT
            expect(created).toMatchObject({ username: 'admin', role: 'ADMIN' });
            expect(created).not.toHaveProperty('password');
            expect(created).not.toHaveProperty('passwordHash');

            const stored = await repositories.users.getById(created.id);
            expect(stored.passwordHash).not.toBe('correct horse');
            await expect(
                new PasswordHasher().verify(
                    'correct horse',
                    stored.passwordHash
                )
            ).resolves.toBe(true);
        });

        test.each([
            ['PARENT', 'parentId'],
            ['EDUCATOR', 'educatorId'],
            ['TEACHER', 'teacherId'],
        ])('a %s account links to its person', async (role, field) => {
            const { [field]: id } = await people();

            const created = await users.create(
                account({ username: 'person', role, [field]: id })
            );

            expect(created[field]).toBe(id);
        });

        test.each(['ADMIN', 'MANAGER'])(
            'a %s account links to no one',
            async (role) => {
                const created = await users.create(account({ role }));

                expect(created).toMatchObject({
                    parentId: null,
                    educatorId: null,
                    teacherId: null,
                });
            }
        );

        test.each([
            ['PARENT without a person', 'PARENT', []],
            ['PARENT linked to an educator', 'PARENT', ['educatorId']],
            [
                'PARENT linked to two people',
                'PARENT',
                ['parentId', 'teacherId'],
            ],
            ['EDUCATOR linked to a parent', 'EDUCATOR', ['parentId']],
            ['TEACHER without a person', 'TEACHER', []],
            ['ADMIN linked to a parent', 'ADMIN', ['parentId']],
            ['MANAGER linked to a teacher', 'MANAGER', ['teacherId']],
        ])(
            'answers 422 USER_PERSON_MISMATCH for %s',
            async (name, role, fields) => {
                // ARRANGE
                const ids = await people();
                const links = Object.fromEntries(
                    fields.map((field) => [field, ids[field]])
                );

                // ACT
                const write = users.create(account({ role, ...links }));

                // ASSERT
                await expect(write).rejects.toMatchObject({
                    status: 422,
                    code: 'USER_PERSON_MISMATCH',
                });
                expect((await repositories.users.findPage()).total).toBe(0);
            }
        );

        test('null links count as no link', async () => {
            const { parentId } = await people();

            const created = await users.create(
                account({
                    role: 'PARENT',
                    parentId,
                    educatorId: null,
                    teacherId: null,
                })
            );

            expect(created.parentId).toBe(parentId);
        });

        test('answers 409 for a taken username', async () => {
            await users.create(account());

            await expect(
                users.create(account({ role: 'MANAGER' }))
            ).rejects.toMatchObject({ status: 409, code: 'UNIQUE_VIOLATION' });
        });

        test('a person has at most one account', async () => {
            const { parentId } = await people();
            await users.create(
                account({ username: 'olena', role: 'PARENT', parentId })
            );

            await expect(
                users.create(
                    account({ username: 'olena2', role: 'PARENT', parentId })
                )
            ).rejects.toMatchObject({ status: 409, code: 'UNIQUE_VIOLATION' });
        });

        test('a teacher who is also a parent has two accounts (BR-41)', async () => {
            const { parentId, teacherId } = await people();

            await users.create(
                account({ username: 'petro', role: 'TEACHER', teacherId })
            );
            await users.create(
                account({ username: 'petro.dad', role: 'PARENT', parentId })
            );

            expect((await repositories.users.findPage()).total).toBe(2);
        });

        test('answers 422 for a person who does not exist', async () => {
            await expect(
                users.create(account({ role: 'PARENT', parentId: uuidv7() }))
            ).rejects.toMatchObject({
                status: 422,
                code: 'REFERENCE_NOT_FOUND',
            });
        });

        test.each([
            ['capital letters', 'Admin'],
            ['a space', 'ad min'],
            ['too short', 'ad'],
        ])('answers 422 for a username with %s', async (name, username) => {
            await expect(
                users.create(account({ username }))
            ).rejects.toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
        });
    });

    describe('reads', () => {
        test('list, get and find never return the password hash', async () => {
            const { id } = await users.create(account());

            const page = await users.list();
            const got = await users.get(id);
            const found = await users.find(id);

            for (const user of [...page.items, got, found]) {
                expect(user).not.toHaveProperty('passwordHash');
                expect(user).toMatchObject({ id, username: 'admin' });
            }
        });

        test('find answers null for a missing account', async () => {
            await expect(users.find(uuidv7())).resolves.toBeNull();
        });

        test('get answers 404 for a missing account', async () => {
            await expect(users.get(uuidv7())).rejects.toMatchObject({
                status: 404,
            });
        });
    });

    test('delete removes the account and leaves its person', async () => {
        // ARRANGE
        const { parentId } = await people();
        const { id } = await users.create(
            account({ username: 'olena', role: 'PARENT', parentId })
        );

        // ACT
        await users.delete(id);

        // ASSERT
        await expect(users.find(id)).resolves.toBeNull();
        await expect(
            repositories.parents.findById(parentId)
        ).resolves.not.toBeNull();
    });

    describe('deleting a person deletes their account', () => {
        test.each([
            ['parent', 'parents', 'PARENT', 'parentId'],
            ['educator', 'educators', 'EDUCATOR', 'educatorId'],
            ['teacher', 'teachers', 'TEACHER', 'teacherId'],
        ])('through the %s service', async (name, service, role, field) => {
            // ARRANGE
            const { [field]: personId } = await people();
            const user = await users.create(
                account({ username: 'person', role, [field]: personId })
            );

            // ACT
            const report = await services[service].delete(personId);

            // ASSERT
            await expect(users.find(user.id)).resolves.toBeNull();
            expect(report.deleted).toEqual(
                expect.arrayContaining([
                    { collection: 'users', id: user.id },
                    { collection: service, id: personId },
                ])
            );
        });

        test('with the last kid of a parent (FR-018)', async () => {
            // ARRANGE
            const { parentId } = await people();
            const user = await users.create(
                account({ username: 'olena', role: 'PARENT', parentId })
            );
            const kid = await repositories.kids.create({
                firstName: 'Marko',
                lastName: 'Koval',
                age: 3,
                sex: 'MALE',
                motherId: parentId,
            });

            // ACT
            const report = await services.kids.delete(kid.id);

            // ASSERT
            await expect(users.find(user.id)).resolves.toBeNull();
            await expect(
                repositories.parents.findById(parentId)
            ).resolves.toBeNull();
            expect(report.deleted).toContainEqual({
                collection: 'users',
                id: user.id,
            });
        });

        test('the database refuses to delete a person who has an account', async () => {
            // the services delete the account first; the database is the
            // last guard against an account that could log in as no one
            const { parentId } = await people();
            await users.create(
                account({ username: 'olena', role: 'PARENT', parentId })
            );

            await expect(
                repositories.parents.delete(parentId)
            ).rejects.toMatchObject({
                status: 409,
                code: 'REFERENCE_RESTRICT',
            });
        });

        test('a person without an account is deleted as before', async () => {
            const { educatorId } = await people();

            await services.educators.delete(educatorId);

            await expect(
                repositories.educators.findById(educatorId)
            ).resolves.toBeNull();
        });
    });
});
