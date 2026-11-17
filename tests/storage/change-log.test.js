import { describe, beforeEach, afterEach, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ChangeLog } from '../../src/storage/change-log.js';
import { createTempDir, removeDir, fileExists } from '../helpers/temp-db.js';

describe('ChangeLog', () => {
    let root;
    let now;
    let log;

    const at = (iso) => {
        now = new Date(iso);
    };
    const file = (day) => path.join(log.directory, `changes-${day}.jsonl`);
    const read = (day) => fs.readFile(file(day), 'utf8');
    const all = async () => {
        const entries = [];
        for await (const entry of log.entries()) entries.push(entry);
        return entries;
    };

    beforeEach(async () => {
        root = await createTempDir();
        at('2026-11-17T10:00:00.000Z');
        log = new ChangeLog(root, { now: () => now });
    });

    afterEach(async () => {
        await removeDir(root);
    });

    test('lives in .changes in the database root, created on the first append', async () => {
        // ASSERT: a dot name is never mistaken for a collection
        expect(log.directory).toBe(path.join(root, '.changes'));
        expect(await fileExists(log.directory)).toBe(false);

        // ACT
        await log.append({ tx: 't1' });

        // ASSERT
        expect(await fileExists(file('2026-11-17'))).toBe(true);
    });

    describe('append', () => {
        test('writes one line per entry, in order', async () => {
            // ACT
            await log.append({ tx: 't1', changes: [{ op: 'create' }] });
            await log.append({ tx: 't2', changes: [] });

            // ASSERT
            expect(await read('2026-11-17')).toBe(
                '{"tx":"t1","changes":[{"op":"create"}]}\n{"tx":"t2","changes":[]}\n'
            );
            expect(await all()).toEqual([
                { tx: 't1', changes: [{ op: 'create' }] },
                { tx: 't2', changes: [] },
            ]);
        });

        test('an entry stays on one line even with line breaks in values', async () => {
            // ACT
            await log.append({ tx: 't1', text: 'first\nsecond\r\nthird' });

            // ASSERT
            const content = await read('2026-11-17');
            expect(content.split('\n')).toHaveLength(2);
            expect((await all())[0].text).toBe('first\nsecond\r\nthird');
        });

        test('starts a new file when the UTC day changes', async () => {
            // ACT: 23:30 in Kyiv is still the 17th in UTC, 01:00 of the 18th too
            at('2026-11-17T23:30:00+02:00');
            await log.append({ tx: 't1' });
            at('2026-11-18T01:00:00+02:00');
            await log.append({ tx: 't2' });
            at('2026-11-18T02:30:00+02:00');
            await log.append({ tx: 't3' });

            // ASSERT
            expect(await read('2026-11-17')).toBe('{"tx":"t1"}\n{"tx":"t2"}\n');
            expect(await read('2026-11-18')).toBe('{"tx":"t3"}\n');
            expect((await all()).map((entry) => entry.tx)).toEqual([
                't1',
                't2',
                't3',
            ]);
        });

        test.each([
            ['no tx', {}],
            ['a tx that is not a string', { tx: 1 }],
            ['an array', [{ tx: 't1' }]],
            ['null', null],
        ])('rejects an entry with %s', async (_label, entry) => {
            await expect(log.append(entry)).rejects.toThrow(TypeError);
            expect(await fileExists(log.directory)).toBe(false);
        });
    });

    describe('entries', () => {
        test('an empty log has no entries', async () => {
            expect(await all()).toEqual([]);
        });

        test('reads files oldest first and ignores other files', async () => {
            // ARRANGE: written out of order, plus files that are not log files
            at('2026-11-18T10:00:00.000Z');
            await log.append({ tx: 'later' });
            at('2026-11-02T10:00:00.000Z');
            await log.append({ tx: 'earlier' });
            await fs.writeFile(path.join(log.directory, 'notes.txt'), 'x');
            await fs.writeFile(
                path.join(log.directory, 'changes-backup.jsonl'),
                'not json\n'
            );

            // ACT & ASSERT
            expect((await all()).map((entry) => entry.tx)).toEqual([
                'earlier',
                'later',
            ]);
        });

        test('a line that is not an entry is reported with its file and number', async () => {
            // ARRANGE
            await log.append({ tx: 't1' });
            await fs.appendFile(file('2026-11-17'), '{"no":"tx"}\n');

            // ACT & ASSERT
            await expect(all()).rejects.toMatchObject({
                code: 'CORRUPT_CHANGE_LOG',
                message:
                    'Line 2 of changes-2026-11-17.jsonl in the change log is not a valid entry.',
            });
        });
    });

    describe('repairTail', () => {
        test('reports null for an empty log', async () => {
            await expect(log.repairTail()).resolves.toBeNull();
        });

        test('reports the tx of the last entry', async () => {
            // ARRANGE
            await log.append({ tx: 't1' });
            await log.append({ tx: 't2' });

            // ACT & ASSERT
            await expect(log.repairTail()).resolves.toBe('t2');
            expect(await read('2026-11-17')).toBe('{"tx":"t1"}\n{"tx":"t2"}\n');
        });

        test('cuts off a line torn by a crash and reports the one before', async () => {
            // ARRANGE: the process stopped in the middle of writing t3
            await log.append({ tx: 't1' });
            await log.append({ tx: 't2' });
            await fs.appendFile(file('2026-11-17'), '{"tx":"t3","chan');

            // ACT
            const last = await log.repairTail();

            // ASSERT
            expect(last).toBe('t2');
            expect(await read('2026-11-17')).toBe('{"tx":"t1"}\n{"tx":"t2"}\n');
        });

        test('a torn line with multi-byte characters is cut at the right byte', async () => {
            // ARRANGE
            await log.append({ tx: 't1', name: 'Ґудзенко' });
            await fs.appendFile(file('2026-11-17'), '{"tx":"t2","name":"Їжа');

            // ACT
            await log.repairTail();

            // ASSERT
            expect(await read('2026-11-17')).toBe(
                '{"tx":"t1","name":"Ґудзенко"}\n'
            );
        });

        test('looks into the previous file when the newest one holds only a torn line', async () => {
            // ARRANGE
            await log.append({ tx: 't1' });
            at('2026-11-18T10:00:00.000Z');
            await fs.writeFile(file('2026-11-18'), '{"tx":"t2"');

            // ACT & ASSERT
            await expect(log.repairTail()).resolves.toBe('t1');
            expect(await read('2026-11-18')).toBe('');
        });

        test('appending works as usual after a repair', async () => {
            // ARRANGE
            await log.append({ tx: 't1' });
            await fs.appendFile(file('2026-11-17'), '{"tx":"t2"');
            await log.repairTail();

            // ACT
            await log.append({ tx: 't2' });

            // ASSERT
            expect((await all()).map((entry) => entry.tx)).toEqual([
                't1',
                't2',
            ]);
        });

        test('a complete line that is not an entry is corruption, not a torn write', async () => {
            // ARRANGE
            await log.append({ tx: 't1' });
            await fs.appendFile(file('2026-11-17'), 'garbage\n');

            // ACT & ASSERT
            await expect(log.repairTail()).rejects.toMatchObject({
                code: 'CORRUPT_CHANGE_LOG',
                status: 500,
            });
            expect(await read('2026-11-17')).toBe('{"tx":"t1"}\ngarbage\n');
        });
    });
});
