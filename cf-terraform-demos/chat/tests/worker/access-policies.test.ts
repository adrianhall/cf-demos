import { describe, expect, it } from 'vitest';
import { buildAccessPolicies } from '../../src/access-policies';

const AUD = 'a'.repeat(64);

/**
 * Evaluate the policy list the way the toolkit's middleware does: first matching pattern wins.
 *
 * @param path Request path to evaluate.
 * @returns The winning policy.
 */
function policyFor(path: string) {
  const policy = buildAccessPolicies(AUD).find((candidate) => candidate.pattern.test(path));
  expect(policy).toBeDefined();
  return policy!;
}

describe('buildAccessPolicies', () => {
  // The absence of any `authenticate: false` entry is the security property, not an omission:
  // this demo has no anonymous surface, so there is nothing a bypass could usefully serve.
  it('has no public policy', () => {
    for (const policy of buildAccessPolicies(AUD)) {
      expect(policy.authenticate).toBe(true);
    }
  });

  // Every Access application in a team shares one JWKS, so a policy without an audience would
  // accept a token minted for an unrelated application in the same team.
  it('carries the audience on every policy', () => {
    for (const policy of buildAccessPolicies(AUD)) {
      expect(policy.audience).toBe(AUD);
    }
  });

  it.each(['/api', '/api/me', '/api/channels', '/api/channels/general/socket'])(
    'answers %s with a status rather than a redirect',
    (path) => {
      const policy = policyFor(path);
      expect(policy.authenticate).toBe(true);
      expect(policy.redirect).toBe(false);
    }
  );

  // A browser's WebSocket constructor cannot follow a redirect to a login page, so redirecting
  // an unauthenticated upgrade would look like an unexplained connection failure instead of an
  // authentication error.
  it('never redirects the WebSocket upgrade path', () => {
    expect(policyFor('/api/channels/deploys/socket').redirect).toBe(false);
  });

  it.each(['/', '/anything', '/apiary'])('redirects the page navigation %s', (path) => {
    const policy = policyFor(path);
    expect(policy.authenticate).toBe(true);
    expect(policy.redirect).toBe(true);
  });

  // `/apiary` starts with the letters "api" but is not under `/api/`. The pattern's boundary
  // requires a slash or end-of-string, so it must fall through to the page policy.
  it('does not treat /apiary as an API path', () => {
    expect(policyFor('/apiary').redirect).toBe(true);
  });

  it('matches every path, so nothing falls through unprotected', () => {
    const policies = buildAccessPolicies(AUD);
    for (const path of ['/', '/api', '/api/x', '/deep/nested/page', '/cdn-cgi/whatever']) {
      expect(policies.some((policy) => policy.pattern.test(path))).toBe(true);
    }
  });
});
