import { describe, expect, it } from 'vitest';
import type { PathPolicy } from '@adrianhall/cloudflare-toolkit/hono';
import { buildAccessPolicies } from '../../src/access-policies.ts';

/**
 * Audience used throughout. The value is irrelevant to the policy shape; what matters is that every
 * authenticating policy carries _this_ one, rather than defaulting or omitting it.
 */
const AUDIENCE = 'a'.repeat(64);

/**
 * Resolves the policy that governs a path, mirroring how the toolkit evaluates the list: first
 * match wins.
 *
 * @param path Request path to resolve.
 * @returns The governing policy.
 * @throws {Error} When no policy matches, which would mean the list has no catch-all and a request
 *   could fall through to the middleware's default.
 */
function policyFor(path: string): PathPolicy {
  const policy = buildAccessPolicies(AUDIENCE).find((candidate) => candidate.pattern.test(path));
  if (!policy) {
    throw new Error(`No policy matched ${path}; the list is missing its catch-all.`);
  }
  return policy;
}

describe('buildAccessPolicies', () => {
  describe('public surface', () => {
    it.each(['/', '/blueprints', '/s/abc123', '/s/abc123/'])('leaves %s public', (path) => {
      expect(policyFor(path).authenticate).toBe(false);
    });

    // The share resolver's whole design hinges on this. It lives under the otherwise
    // authenticated `/api/` prefix, so it stays public only because its carve-out is listed
    // *before* the general `/api/` policy. Reorder the two and anonymous sharing breaks.
    it('leaves the anonymous share resolver public despite its /api/ prefix', () => {
      expect(policyFor('/api/shares/sometoken').authenticate).toBe(false);
    });

    it('leaves the health probe public so it can answer when authentication is what is broken', () => {
      expect(policyFor('/api/health').authenticate).toBe(false);
    });
  });

  describe('authenticated surface', () => {
    it.each(['/api/diagrams', '/api/diagrams/123', '/api/me', '/api/admin/users'])(
      'requires authentication for %s',
      (path) => {
        expect(policyFor(path).authenticate).toBe(true);
      }
    );

    it.each(['/app', '/app/', '/app/admin', '/app/diagram/123'])(
      'requires authentication for %s',
      (path) => {
        expect(policyFor(path).authenticate).toBe(true);
      }
    );

    // Declared before the route exists, on purpose. The catch-all is a default-public rule, so a
    // path added later without an entry of its own inherits anonymous access — and that is a
    // failure that looks like nothing until someone finds the open endpoint.
    it.each(['/mcp', '/mcp/', '/mcp/anything'])(
      'requires authentication for the reserved %s',
      (path) => {
        expect(policyFor(path).authenticate).toBe(true);
      }
    );

    // Every Access application in a team shares one JWKS, so a token minted for an unrelated
    // application would pass signature validation. The audience is the only thing that stops it,
    // and a policy that authenticates without one would accept it.
    it('threads the audience into every authenticating policy', () => {
      const authenticating = buildAccessPolicies(AUDIENCE).filter((policy) => policy.authenticate);

      expect(authenticating.length).toBeGreaterThan(0);
      for (const policy of authenticating) {
        expect(policy.audience).toBe(AUDIENCE);
      }
    });
  });

  describe('redirect behaviour', () => {
    // Without an explicit `redirect: false`, an API caller sending `Accept: text/html` receives
    // the HTML of a login page instead of a status its error handling can render — and a
    // WebSocket upgrade cannot follow such a redirect at all.
    // `/mcp` is included for the same reason as the API paths and one more: an MCP client is never
    // a browser navigation, so a redirect to a login page is as un-completable for it as for a
    // `fetch`.
    it.each(['/api/diagrams', '/api/me', '/api/admin/users', '/mcp'])(
      'never redirects %s',
      (path) => {
        expect(policyFor(path).redirect).toBe(false);
      }
    );

    // A page navigation is the one case where a redirect to the login page is the right answer.
    it('redirects an unauthenticated page navigation into /app', () => {
      expect(policyFor('/app').redirect).toBe(true);
    });
  });

  describe('ordering', () => {
    it('puts the public catch-all last so a new path cannot silently inherit it', () => {
      const policies = buildAccessPolicies(AUDIENCE);
      const last = policies.at(-1);

      expect(last?.pattern.source).toBe(/^\//u.source);
      expect(last?.authenticate).toBe(false);
    });

    it('lists the share carve-out before the general /api policy', () => {
      const policies = buildAccessPolicies(AUDIENCE);
      const shareIndex = policies.findIndex((policy) => policy.pattern.test('/api/shares/x'));
      const apiIndex = policies.findIndex((policy) => policy.pattern.test('/api/diagrams'));

      expect(shareIndex).toBeGreaterThanOrEqual(0);
      expect(shareIndex).toBeLessThan(apiIndex);
    });

    // A path prefix match must not leak: `/apifoo` is not under `/api`, and `/application` is not
    // under `/app`. Both would be an authorization decision made by accident.
    it.each([
      ['/apifoo', false],
      ['/application', false],
      ['/mcpfoo', false]
    ])('treats %s as public rather than a prefix match', (path, authenticate) => {
      expect(policyFor(path).authenticate).toBe(authenticate);
    });
  });
});
