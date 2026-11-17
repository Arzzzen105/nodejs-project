import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import path from 'node:path';
import { FileDatabase } from '../../src/storage/file-database.js';
import { createContainer } from '../../src/container.js';
import { PasswordHasher } from '../../src/security/password-hasher.js';
import { TokenIssuer } from '../../src/security/token-issuer.js';
import { copySchema } from '../../scripts/copy-schema.js';
import { createTempDir, removeDir } from '../helpers/temp-db.js';

const SCHEMA = path.resolve(import.meta.dirname, '..', '..', 'database');

describe('AuthService', () => {
    let root;
    let db;
    let auth;
    let services;
    let repositories;

    beforeEach(async () => {
        root = await createTempDir();
        await copySchema(SCHEMA, root);
        db = await new FileDatabase(root).init();
        ({ services, repositories } = createContainer(db, {
            passwordRounds: 4,
            tokenSecret: 'secret',
        }));
        auth = services.auth;
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await db?.close();
        await removeDir(root);
    });

    const ADMIN = { username: 'admin', password: 'correct horse' };

    describe('login', () => {
        test('answers a token of the account and the account', async () => {
            // ARRANGE
            const admin = await auth.ensureAdmin(ADMIN);

            // ACT
            const result = await auth.login('admin', 'correct horse');

            // ASSERT
            expect(result.user).toEqual(admin);
            expect(result.user).not.toHaveProperty('passwordHash');
            expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
            expect(
                new TokenIssuer({ secret: 'secret' }).verify(result.token)
            ).toMatchObject({ sub: admin.id, role: 'ADMIN' });
        });

        test.each([
            ['a wrong password', 'admin', 'correct hors'],
            ['an unknown username', 'nobody', 'correct horse'],
        ])(
            'answers %s with the same 401 INVALID_CREDENTIALS',
            async (name, username, password) => {
                await auth.ensureAdmin(ADMIN);

                await expect(
                    auth.login(username, password)
                ).rejects.toMatchObject({
                    status: 401,
                    code: 'INVALID_CREDENTIALS',
                    message: 'The username or the password is wrong.',
                });
            }
        );

        test('checks a hash for an unknown username too', async () => {
            // the answer then takes about as long as for a wrong password
            const verify = vi.spyOn(PasswordHasher.prototype, 'verify');

            await expect(auth.login('nobody', 'x')).rejects.toMatchObject({
                code: 'INVALID_CREDENTIALS',
            });

            expect(verify).toHaveBeenCalledTimes(1);
        });
    });

    describe('authenticate', () => {
        test('answers the account of a valid token', async () => {
            const admin = await auth.ensureAdmin(ADMIN);
            const { token } = await auth.login('admin', 'correct horse');

            await expect(auth.authenticate(token)).resolves.toEqual(admin);
        });

        test.each([
            ['garbage', 'not-a-token'],
            [
                'a token signed with another secret',
                new TokenIssuer({ secret: 'other' }).issue({
                    id: '0190a000-0000-7000-8000-000000000000',
                    role: 'ADMIN',
                }).token,
            ],
        ])('answers 401 UNAUTHENTICATED for %s', async (name, token) => {
            await expect(auth.authenticate(token)).rejects.toMatchObject({
                status: 401,
                code: 'UNAUTHENTICATED',
            });
        });

        test('a token of a deleted account stops working at once', async () => {
            // ARRANGE
            await auth.ensureAdmin(ADMIN);
            const manager = await services.users.create({
                username: 'manager',
                password: 'correct horse',
                role: 'MANAGER',
            });
            const { token } = await auth.login('manager', 'correct horse');

            // ACT
            await services.users.delete(manager.id);

            // ASSERT
            await expect(auth.authenticate(token)).rejects.toMatchObject({
                status: 401,
                code: 'UNAUTHENTICATED',
            });
        });
    });

    describe('ensureAdmin', () => {
        test('creates an admin in a database without accounts', async () => {
            const admin = await auth.ensureAdmin(ADMIN);

            expect(admin).toMatchObject({ username: 'admin', role: 'ADMIN' });
            expect(admin).not.toHaveProperty('passwordHash');
            await expect(
                auth.login('admin', 'correct horse')
            ).resolves.toBeDefined();
        });

        test('does nothing once any account exists', async () => {
            await auth.ensureAdmin(ADMIN);

            const again = await auth.ensureAdmin({
                username: 'second',
                password: 'other password',
            });

            expect(again).toBeNull();
            expect((await repositories.users.findPage()).total).toBe(1);
        });

        test('needs no credentials once accounts exist', async () => {
            await auth.ensureAdmin(ADMIN);

            await expect(auth.ensureAdmin({})).resolves.toBeNull();
        });

        test('fails without credentials in a database without accounts', async () => {
            await expect(auth.ensureAdmin({})).rejects.toThrow(/no accounts/);
        });
    });
});
