import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import path from 'node:path';
import { FileDatabase } from '../../src/storage/file-database.js';
import { BaseRepository } from '../../src/repositories/base-repository.js';
import { UnitOfWork } from '../../src/repositories/unit-of-work.js';
import { createContainer } from '../../src/container.js';
import { copySchema } from '../../scripts/copy-schema.js';
import { createTempDir, removeDir } from '../helpers/temp-db.js';

const SCHEMA = path.resolve(import.meta.dirname, '..', '..', 'database');

describe('createContainer', () => {
    let root;
    let db;
    let container;

    beforeEach(async () => {
        root = await createTempDir();
        await copySchema(SCHEMA, root);
        db = await new FileDatabase(root).init();
        container = createContainer(db);
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    test('every collection of the schema has a repository, and only those', () => {
        // a new collection in database/ needs its repository registered here
        const collections = Object.values(container.repositories)
            .map((repository) => repository.collection)
            .sort();
        expect(collections).toEqual([...db.collections()].sort());
    });

    test('repositories are registered under their collection names', () => {
        for (const [name, repository] of Object.entries(
            container.repositories
        )) {
            expect(repository).toBeInstanceOf(BaseRepository);
            expect(repository.collection).toBe(name);
        }
    });

    test('every repository has a service under the same name, and only those', () => {
        // a new repository needs its service registered here
        expect(Object.keys(container.services).sort()).toEqual(
            Object.keys(container.repositories).sort()
        );
    });

    test('each service works over its own repository', async () => {
        for (const [name, service] of Object.entries(container.services)) {
            // ARRANGE
            const page = { items: [], total: 0, limit: 100, offset: 0 };
            const findPage = vi
                .spyOn(container.repositories[name], 'findPage')
                .mockResolvedValue(page);

            // ACT
            const result = await service.list({ limit: 100 });

            // ASSERT
            expect(result, name).toBe(page);
            expect(findPage, name).toHaveBeenCalledWith({ limit: 100 });
        }
    });

    test('everything shares one unit of work over the given database', async () => {
        // ARRANGE
        const { uow, repositories } = container;
        expect(uow).toBeInstanceOf(UnitOfWork);
        expect(container.database).toBe(db);

        // ACT: a unit opened through the shared uow spans every repository
        await expect(
            uow.run(async () => {
                const room = await repositories.rooms.create({ name: 'Зал' });
                await repositories.subjects.create({ name: 'Музика' });
                expect(await repositories.rooms.findById(room.id)).toEqual(
                    room
                );
                throw new Error('roll back');
            })
        ).rejects.toThrow('roll back');

        // ASSERT
        expect((await repositories.rooms.findPage()).total).toBe(0);
        expect((await repositories.subjects.findPage()).total).toBe(0);
    });

    test('the container cannot be changed after it is built', () => {
        expect(Object.isFrozen(container)).toBe(true);
        expect(Object.isFrozen(container.repositories)).toBe(true);
        expect(Object.isFrozen(container.services)).toBe(true);
    });
});
