import jwt from 'jsonwebtoken';

// Only this algorithm is accepted: a token cannot pick a weaker one, or "none".
const ALGORITHM = 'HS256';

/**
 * Issues and checks access tokens: JWT signed with a secret of the server.
 * The server stores no tokens, so a token works until it expires.
 *
 * @example
 * const tokens = new TokenIssuer({ secret: process.env.JWT_SECRET, ttl: '8h' });
 * const { token } = tokens.issue(user);
 * tokens.verify(token); // { sub: user.id, role: user.role, iat, exp }
 */
export class TokenIssuer {
    #secret;
    #ttl;

    /**
     * @param {object} options
     * @param {string} options.secret Key of the signature; whoever knows it
     *   can issue tokens
     * @param {string|number} [options.ttl='8h'] Lifetime: seconds, or a
     *   string such as '30m', '8h', '7d'
     * @throws {Error} If the lifetime is not valid
     */
    constructor({ secret, ttl = '8h' }) {
        this.#secret = secret;
        this.#ttl = ttl;
        // a wrong lifetime fails here, at startup, and not at the first login
        if (secret) this.issue({ id: 'check', role: 'check' });
    }

    /**
     * @param {{ id: string, role: string }} user
     * @returns {{ token: string, expiresAt: string }} The token and when it
     *   expires, as an ISO 8601 datetime
     */
    issue(user) {
        const token = jwt.sign({ role: user.role }, this.#secret, {
            algorithm: ALGORITHM,
            subject: user.id,
            expiresIn: this.#ttl,
        });
        const { exp } = jwt.decode(token);
        return { token, expiresAt: new Date(exp * 1000).toISOString() };
    }

    /**
     * @param {string} token
     * @returns {{ sub: string, role: string, iat: number, exp: number }}
     * @throws {Error} If the token is malformed, signed with another key or
     *   algorithm, or expired
     */
    verify(token) {
        return jwt.verify(token, this.#secret, { algorithms: [ALGORITHM] });
    }
}
