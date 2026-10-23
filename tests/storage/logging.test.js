import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileDatabase } from '../../src/storage/file-database.js';
import { Collection } from '../../src/storage/collection.js';
import { Journal } from '../../src/storage/journal.js';
import { RelationManager } from '../../src/storage/relation-manager.js';
import { TransactionManager } from '../../src/storage/transaction-manager.js';
import {
    assertLogger,
    defaultLogger,
} from '../../src/storage/logger-contract.js';
import {
    createTempDir,
    removeDir,
    writeCollectionConfig,
} from '../helpers/temp-db.js';
import { createTestLogger } from '../helpers/test-logger.js';

const OWNERS = {
    table: 'owners',
    primaryKey: 'id',
    columns: {
        name: { type: 'string', required: true },
        phone: { type: 'string' },
    },
    indexes: ['name'],
};

describe('defaultLogger', () => {
    test('debug and info are silent', () => {
        // ARRANGE
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});

        try {
            // ACT
            defaultLogger.debug({ a: 1 }, 'debug');
            defaultLogger.info({ a: 1 }, 'info');

            // ASSERT
            expect(log).not.toHaveBeenCalled();
            expect(info).not.toHaveBeenCalled();
        } finally {
            log.mockRestore();
            info.mockRestore();
        }
    });

    test('warn and error go to the console with fields as JSON', () => {
        // ARRANGE
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            // ACT
            defaultLogger.warn({ id: 'x' }, 'Careful');
            defaultLogger.error({}, 'Broken');

            // ASSERT
            expect(warn).toHaveBeenCalledWith(
                '[file-database] Careful {"id":"x"}'
            );
            expect(error).toHaveBeenCalledWith('[file-database] Broken');
        } finally {
            warn.mockRestore();
            error.mockRestore();
        }
    });

    test('errors are logged with their message and code', () => {
        // ARRANGE
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const failure = Object.assign(new Error('disk full'), {
            code: 'ENOSPC',
        });

        try {
            // ACT
            defaultLogger.error({ err: failure }, 'Write failed');

            // ASSERT
            expect(error).toHaveBeenCalledWith(
                '[file-database] Write failed {"err":{"message":"disk full","code":"ENOSPC"}}'
            );
        } finally {
            error.mockRestore();
        }
    });
});

describe('assertLogger', () => {
    test('accepts objects with all levels, including console', () => {
        expect(() => assertLogger(createTestLogger())).not.toThrow();
        expect(() => assertLogger(console)).not.toThrow();
    });

    test.each([
        ['null', null],
        ['missing debug', { info() {}, warn() {}, error() {} }],
        ['non-function level', { debug: 1, info() {}, warn() {}, error() {} }],
    ])('rejects %s', (_label, logger) => {
        expect(() => assertLogger(logger)).toThrow(TypeError);
    });
});

describe('database logging', () => {
    let root;
    let db;
    let logger;

    async function open(options = {}) {
        db = new FileDatabase(root, { logger, ...options });
        await db.init();
        return db;
    }

    beforeEach(async () => {
        root = await createTempDir();
        await writeCollectionConfig(root, 'owners', OWNERS);
        logger = createTestLogger();
    });

    afterEach(async () => {
        await db?.close();
        await removeDir(root);
    });

    test('rejects an invalid logger at construction', () => {
        expect(() => new FileDatabase(root, { logger: {} })).toThrow(TypeError);
    });

    test('logs opening and closing', async () => {
        // ARRANGE
        await open();
        await db.create('owners', { name: 'Ann' });
        await db.close();
        logger.entries.length = 0;

        // ACT
        await open();
        await db.close();

        // ASSERT
        expect(logger.at('info')).toEqual([
            {
                level: 'info',
                fields: {
                    root,
                    collections: 1,
                    records: 1,
                    warnings: 0,
                    ms: expect.any(Number),
                },
                message: 'Database opened',
            },
            {
                level: 'info',
                fields: { root },
                message: 'Database closed',
            },
        ]);
    });

    test('logs every commit with a summary at debug level', async () => {
        // ARRANGE
        await open();

        // ACT
        await db.transaction(async (tx) => {
            await tx.create('owners', { name: 'Ann' });
            await tx.create('owners', { name: 'Bob' });
        });

        // ASSERT
        expect(logger.at('debug')).toContainEqual({
            level: 'debug',
            fields: {
                changes: 2,
                collections: { owners: 2 },
                ms: expect.any(Number),
            },
            message: 'Transaction committed',
        });
    });

    test('logs rollbacks and failed transactions at debug level', async () => {
        // ARRANGE
        await open();

        // ACT
        await db.transaction((tx) => tx.rollback());
        await db.create('owners', {}).catch(() => {});

        // ASSERT
        expect(logger.at('debug').map((e) => e.message)).toEqual([
            'Transaction rolled back',
            'Transaction failed and was rolled back',
        ]);
        expect(logger.at('debug')[1].fields.code).toBe('VALIDATION_ERROR');
    });

    test('logs a transaction timeout as a warning', async () => {
        // ARRANGE
        await open({ transactionTimeout: 10 });

        // ACT
        await db.transaction(() => new Promise(() => {})).catch(() => {});

        // ASSERT
        expect(logger.at('warn')).toEqual([
            {
                level: 'warn',
                fields: { timeout: 10 },
                message: 'Transaction timed out and was rolled back',
            },
        ]);
    });

    test('logs a recovered journal as a warning', async () => {
        // ARRANGE
        await open();
        const owner = await db.create('owners', { name: 'Ann' });
        await db.close();
        await new Journal(root).write([
            { collection: 'owners', id: owner.id, record: null },
        ]);
        logger.entries.length = 0;

        // ACT
        await open();

        // ASSERT
        expect(logger.at('warn')).toEqual([
            {
                level: 'warn',
                fields: { changes: 1 },
                message:
                    'Finishing a commit interrupted by a crash, found in the journal',
            },
        ]);
    });

    test('logs taking over a lock of a crashed process as a warning', async () => {
        // ARRANGE
        const child = spawn(process.execPath, ['-e', '']);
        await new Promise((resolve) => child.on('exit', resolve));
        await fs.writeFile(
            path.join(root, '.lock'),
            JSON.stringify({
                pid: child.pid,
                hostname: os.hostname(),
                startedAt: 'earlier',
            })
        );

        // ACT
        await open();

        // ASSERT
        expect(logger.at('warn')).toEqual([
            {
                level: 'warn',
                fields: {
                    path: path.join(root, '.lock'),
                    previousOwner: { pid: child.pid, hostname: os.hostname() },
                },
                message:
                    'Taking over a lock left by a process that is no longer running',
            },
        ]);
    });

    test('never logs record contents', async () => {
        // ARRANGE
        const secrets = ['Olena Secret', '+380 00 000 0000', 'Renamed Secret'];
        await open({ transactionTimeout: 10 });

        // ACT: every kind of operation, including failing ones
        const owner = await db.create('owners', {
            name: secrets[0],
            phone: secrets[1],
        });
        await db.update('owners', owner.id, { name: secrets[2] });
        await db.update('owners', owner.id, { phone: 42 }).catch(() => {});
        await db.list('owners', { where: { name: secrets[2] } });
        await db.delete('owners', owner.id);
        await db
            .transaction(async (tx) => {
                await tx.create('owners', { name: secrets[0] });
                await new Promise(() => {});
            })
            .catch(() => {});
        await db.close();

        // ASSERT
        const logged = JSON.stringify(logger.entries);
        for (const secret of secrets) {
            expect(logged).not.toContain(secret);
        }
        expect(logger.entries.length).toBeGreaterThan(5);
    });
});

describe('commit failure logging', () => {
    let root;
    let owners;
    let journal;
    let logger;
    let manager;

    beforeEach(async () => {
        root = await createTempDir();
        const directory = await writeCollectionConfig(root, 'owners', OWNERS);
        owners = new Collection('owners', directory, OWNERS);
        await owners.loadRecords();
        journal = new Journal(root);
        logger = createTestLogger();
        manager = new TransactionManager({
            journal,
            collection: () => owners,
            relations: new RelationManager(new Map([['owners', OWNERS]])),
            logger,
        });
    });

    afterEach(async () => {
        await removeDir(root);
    });

    test('a failed apply is logged as an error', async () => {
        // ARRANGE
        const failure = new Error('disk full');
        owners.applyPut = async () => {
            throw failure;
        };

        // ACT
        await manager
            .run((tx) => tx.create('owners', { name: 'Ann' }))
            .catch(() => {});

        // ASSERT
        expect(logger.at('error')).toEqual([
            {
                level: 'error',
                fields: { err: failure, changes: 1 },
                message: expect.stringContaining(
                    'Failed to apply a committed transaction'
                ),
            },
        ]);
    });

    test('a failed journal removal is logged as an error', async () => {
        // ARRANGE
        journal.clear = async () => {
            throw new Error('EIO');
        };

        // ACT
        await manager.run((tx) => tx.create('owners', { name: 'Ann' }));

        // ASSERT
        expect(logger.at('error').map((e) => e.message)).toEqual([
            'Cannot remove the transaction journal; writes are disabled until restart',
        ]);
    });

    test('a discarded journal write is logged as a warning', async () => {
        // ARRANGE
        journal.write = async () => {
            throw new Error('fsync failed');
        };

        // ACT
        await manager
            .run((tx) => tx.create('owners', { name: 'Ann' }))
            .catch(() => {});

        // ASSERT
        expect(logger.at('warn').map((e) => e.message)).toEqual([
            'Failed to write the transaction journal; the transaction was discarded',
        ]);
        expect(logger.at('error')).toEqual([]);
    });
});
