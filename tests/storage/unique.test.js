import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { FileDatabase } from '../../src/storage/file-database.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
} from '../helpers/temp-db.js';
import { createTestLogger } from '../helpers/test-logger.js';

function collectionConfig(name, columns, indexes = []) {
    return { table: name, primaryKey: 'id', columns, indexes };
}

const CONFIGS = {
    parents: collectionConfig('parents', {
        name: { type: 'string', required: true },
        email: { type: 'string', nullable: true, unique: true },
        badge: { type: 'integer', unique: true },
    }),
    rooms: collectionConfig('rooms', {
        name: { type: 'string', required: true },
    }),
    groups: collectionConfig('groups', {
        name: { type: 'string', required: true },
        roomId: {
            type: 'string',
            nullable: true,
            default: null,
            unique: true,
            references: { collection: 'rooms', onDelete: 'setNull' },
        },
    }),
};

const UNIQUE_VIOLATION = { code: 'UNIQUE_VIOLATION', status: 409 };

describe('unique columns', () => {
    let root;
    let db;
    let logger;

    async function openDatabase() {
        db = new FileDatabase(root, { logger });
        await db.init();
        return db;
    }

    async function reopen() {
        await db.close();
        return openDatabase();
    }

    beforeEach(async () => {
        root = await createTempDir();
        for (const [name, config] of Object.entries(CONFIGS)) {
            await writeCollectionConfig(root, name, config);
        }
        logger = createTestLogger();
        await openDatabase();
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    describe('create', () => {
        test('rejects a taken value without writing anything', async () => {
            // ARRANGE
            await db.create('parents', { name: 'Ann', email: 'ann@mail.com' });

            // ACT & ASSERT
            await expect(
                db.create('parents', { name: 'Fake', email: 'ann@mail.com' })
            ).rejects.toMatchObject({
                ...UNIQUE_VIOLATION,
                message: '"email" must be unique.',
            });
            expect((await db.list('parents')).total).toBe(1);
        });

        test('the error does not reveal who holds the value', async () => {
            // ARRANGE
            const ann = await db.create('parents', {
                name: 'Ann',
                email: 'ann@mail.com',
            });

            // ACT
            const error = await db
                .create('parents', { name: 'B', email: 'ann@mail.com' })
                .catch((e) => e);

            // ASSERT
            expect(error.message).not.toContain(ann.id);
            expect(error.message).not.toContain('ann@mail.com');
        });

        test('many records may have null or no value', async () => {
            // ACT
            await db.create('parents', { name: 'A', email: null });
            await db.create('parents', { name: 'B', email: null });
            await db.create('parents', { name: 'C' });
            await db.create('parents', { name: 'D' });

            // ASSERT
            expect((await db.list('parents')).total).toBe(4);
        });

        test('works for numbers too', async () => {
            // ARRANGE
            await db.create('parents', { name: 'A', badge: 7 });

            // ACT & ASSERT
            await expect(
                db.create('parents', { name: 'B', badge: 7 })
            ).rejects.toMatchObject(UNIQUE_VIOLATION);
            await expect(
                db.create('parents', { name: 'B', badge: 8 })
            ).resolves.toBeTruthy();
        });

        test('strings are compared case-sensitively', async () => {
            // ACT & ASSERT
            await db.create('parents', { name: 'A', email: 'Ann@mail.com' });
            await expect(
                db.create('parents', { name: 'B', email: 'ann@mail.com' })
            ).resolves.toBeTruthy();
        });

        test('unique columns are indexed for queries', async () => {
            // ARRANGE
            const ann = await db.create('parents', {
                name: 'Ann',
                email: 'ann@mail.com',
            });

            // ACT & ASSERT
            const found = await db.list('parents', {
                where: { email: 'ann@mail.com' },
            });
            expect(found.items).toEqual([ann]);
        });
    });

    describe('update', () => {
        test('keeping its own value is not a conflict', async () => {
            // ARRANGE
            const ann = await db.create('parents', {
                name: 'Ann',
                email: 'ann@mail.com',
            });

            // ACT & ASSERT
            await expect(
                db.update('parents', ann.id, { name: 'Anna' })
            ).resolves.toMatchObject({ email: 'ann@mail.com' });
            await expect(
                db.update('parents', ann.id, {
                    name: 'Anna',
                    email: 'ann@mail.com',
                })
            ).resolves.toBeTruthy();
        });

        test('taking another record value is rejected', async () => {
            // ARRANGE
            await db.create('parents', { name: 'Ann', email: 'ann@mail.com' });
            const bob = await db.create('parents', {
                name: 'Bob',
                email: 'bob@mail.com',
            });

            // ACT & ASSERT
            await expect(
                db.update('parents', bob.id, { email: 'ann@mail.com' })
            ).rejects.toMatchObject(UNIQUE_VIOLATION);
            expect((await db.get('parents', bob.id)).email).toBe(
                'bob@mail.com'
            );
        });

        test('replace (PUT) is checked as well', async () => {
            // ARRANGE
            await db.create('parents', { name: 'Ann', email: 'ann@mail.com' });
            const bob = await db.create('parents', { name: 'Bob' });

            // ACT & ASSERT
            await expect(
                db.update(
                    'parents',
                    bob.id,
                    { name: 'Bob', email: 'ann@mail.com' },
                    { replace: true }
                )
            ).rejects.toMatchObject(UNIQUE_VIOLATION);
        });

        test('a deleted record frees its value', async () => {
            // ARRANGE
            const ann = await db.create('parents', {
                name: 'Ann',
                email: 'ann@mail.com',
            });
            await db.delete('parents', ann.id);

            // ACT & ASSERT
            await expect(
                db.create('parents', { name: 'New', email: 'ann@mail.com' })
            ).resolves.toBeTruthy();
        });
    });

    describe('inside a transaction', () => {
        test('a value freed earlier in the transaction can be taken', async () => {
            // ARRANGE
            const ann = await db.create('parents', {
                name: 'Ann',
                email: 'shared@mail.com',
            });

            // ACT
            const bob = await db.transaction(async (tx) => {
                await tx.update('parents', ann.id, { email: 'ann@mail.com' });
                return tx.create('parents', {
                    name: 'Bob',
                    email: 'shared@mail.com',
                });
            });

            // ASSERT
            expect(bob.email).toBe('shared@mail.com');
        });

        test('a value taken earlier in the transaction is no longer free', async () => {
            // ACT & ASSERT
            await expect(
                db.transaction(async (tx) => {
                    await tx.create('parents', {
                        name: 'A',
                        email: 'x@mail.com',
                    });
                    await tx.create('parents', {
                        name: 'B',
                        email: 'x@mail.com',
                    });
                })
            ).rejects.toMatchObject(UNIQUE_VIOLATION);
            expect((await db.list('parents')).total).toBe(0);
        });

        test('values are swapped through an intermediate null', async () => {
            // ARRANGE
            const a = await db.create('parents', { name: 'A', email: 'a@m' });
            const b = await db.create('parents', { name: 'B', email: 'b@m' });

            // ACT: a direct swap fails, checks are immediate
            await expect(
                db.transaction(async (tx) => {
                    await tx.update('parents', a.id, { email: 'b@m' });
                })
            ).rejects.toMatchObject(UNIQUE_VIOLATION);
            await db.transaction(async (tx) => {
                await tx.update('parents', a.id, { email: null });
                await tx.update('parents', b.id, { email: 'a@m' });
                await tx.update('parents', a.id, { email: 'b@m' });
            });

            // ASSERT
            expect((await db.get('parents', a.id)).email).toBe('b@m');
            expect((await db.get('parents', b.id)).email).toBe('a@m');
        });
    });

    describe('one-to-one through references', () => {
        test('two groups cannot share a room, and a freed room can be reused', async () => {
            // ARRANGE
            const room = await db.create('rooms', { name: 'Sunny' });
            const first = await db.create('groups', {
                name: 'Bees',
                roomId: room.id,
            });

            // ACT & ASSERT
            await expect(
                db.create('groups', { name: 'Ants', roomId: room.id })
            ).rejects.toMatchObject(UNIQUE_VIOLATION);
            await db.update('groups', first.id, { roomId: null });
            await expect(
                db.create('groups', { name: 'Ants', roomId: room.id })
            ).resolves.toBeTruthy();
        });

        test('many groups may have no room, also after setNull', async () => {
            // ARRANGE
            const room = await db.create('rooms', { name: 'Sunny' });
            await db.create('groups', { name: 'Bees', roomId: room.id });
            await db.create('groups', { name: 'Ants' });

            // ACT: setNull of the deleted room leaves two groups without one
            await db.delete('rooms', room.id);

            // ASSERT
            const roomless = await db.list('groups', {
                where: { roomId: null },
            });
            expect(roomless.total).toBe(2);
        });
    });

    describe('duplicates already stored', () => {
        async function writeParent(fields) {
            const record = { id: uuidv7(), ...fields };
            await fs.writeFile(
                path.join(root, 'parents', `${record.id}.json`),
                JSON.stringify(record)
            );
            return record;
        }

        test('are reported as warnings at start, not fatal', async () => {
            // ARRANGE
            await db.close();
            const a = await writeParent({ name: 'A', email: 'dup@mail.com' });
            const b = await writeParent({ name: 'B', email: 'dup@mail.com' });
            await writeParent({ name: 'C', email: null });
            await writeParent({ name: 'D', email: null });

            // ACT
            await openDatabase();

            // ASSERT
            const warnings = db.warnings.filter(
                (w) => w.code === 'DUPLICATE_VALUE'
            );
            expect(warnings.map((w) => w.id).sort()).toEqual(
                [a.id, b.id].sort()
            );
            expect(warnings[0]).toMatchObject({
                collection: 'parents',
                message:
                    '"email" must be unique, but 1 other record(s) have the same value.',
            });
            expect(
                logger
                    .at('warn')
                    .filter((e) => e.fields.code === 'DUPLICATE_VALUE')
                    .map((e) => e.message)
            ).toEqual([
                expect.stringMatching(/^Record shares a unique value: /),
                expect.stringMatching(/^Record shares a unique value: /),
            ]);
        });

        test('records with a duplicate stay editable, and can be fixed', async () => {
            // ARRANGE
            await db.close();
            const a = await writeParent({ name: 'A', email: 'dup@mail.com' });
            const b = await writeParent({ name: 'B', email: 'dup@mail.com' });
            await openDatabase();

            // ACT & ASSERT: other fields can change while the duplicate stays
            await expect(
                db.update('parents', a.id, { name: 'Anna' })
            ).resolves.toMatchObject({ email: 'dup@mail.com' });
            // fixing one of them removes the duplicate
            await db.update('parents', b.id, { email: 'bob@mail.com' });
            await reopen();
            expect(
                db.warnings.filter((w) => w.code === 'DUPLICATE_VALUE')
            ).toEqual([]);
        });

        test('a duplicated value still cannot be given to a third record', async () => {
            // ARRANGE
            await db.close();
            await writeParent({ name: 'A', email: 'dup@mail.com' });
            await writeParent({ name: 'B', email: 'dup@mail.com' });
            await openDatabase();

            // ACT & ASSERT
            await expect(
                db.create('parents', { name: 'C', email: 'dup@mail.com' })
            ).rejects.toMatchObject(UNIQUE_VIOLATION);
        });
    });
});
