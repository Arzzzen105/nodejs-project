import { describe, afterEach, test, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { TokenIssuer } from '../../src/security/token-issuer.js';

describe('TokenIssuer', () => {
    const user = { id: '0190a000-0000-7000-8000-000000000000', role: 'ADMIN' };
    const tokens = new TokenIssuer({ secret: 'secret', ttl: '8h' });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('a token it issued verifies to the user and the role', () => {
        const { token } = tokens.issue(user);

        expect(tokens.verify(token)).toMatchObject({
            sub: user.id,
            role: 'ADMIN',
        });
    });

    test('the token expires after its lifetime', () => {
        // ARRANGE
        vi.useFakeTimers({ now: new Date('2026-11-17T08:00:00Z') });

        // ACT
        const { token, expiresAt } = tokens.issue(user);

        // ASSERT
        expect(expiresAt).toBe('2026-11-17T16:00:00.000Z');
        vi.setSystemTime(new Date('2026-11-17T15:59:59Z'));
        expect(() => tokens.verify(token)).not.toThrow();
        vi.setSystemTime(new Date('2026-11-17T16:00:01Z'));
        expect(() => tokens.verify(token)).toThrow(/expired/);
    });

    test('rejects a token signed with another secret', () => {
        const other = new TokenIssuer({ secret: 'another' }).issue(user);

        expect(() => tokens.verify(other.token)).toThrow();
    });

    test('rejects an unsigned token, whatever it claims', () => {
        const unsigned = jwt.sign({ role: 'ADMIN' }, null, {
            algorithm: 'none',
            subject: user.id,
        });

        expect(() => tokens.verify(unsigned)).toThrow();
    });

    test('rejects a token with a changed role', () => {
        // ARRANGE
        const { token } = tokens.issue({ ...user, role: 'PARENT' });
        const [header, , signature] = token.split('.');
        const payload = Buffer.from(
            JSON.stringify({ sub: user.id, role: 'ADMIN' })
        ).toString('base64url');

        // ACT + ASSERT
        expect(() =>
            tokens.verify(`${header}.${payload}.${signature}`)
        ).toThrow(/signature/);
    });

    test('rejects garbage', () => {
        expect(() => tokens.verify('not-a-token')).toThrow();
    });

    test('a wrong lifetime fails when it is created', () => {
        expect(() => new TokenIssuer({ secret: 's', ttl: 'soon' })).toThrow();
    });
});
