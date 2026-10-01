import { describe, expect, it } from 'vitest';
import { buildAccessPolicies } from '../../src/access-policies';

const AUD = 'a'.repeat(64);

/**
 * Resolve a request path against the policy list the way the middleware does: first match wins.
 *
 * @param path Request pathname to evaluate.
 * @returns The matching policy.
 */
function policyFor(path: string) {
  const policy = buildAccessPolicies(AUD).find((candidate) => candidate.pattern.test(path));
  expect(policy).toBeDefined();
  return policy!;
}

describe('buildAccessPolicies', () => {
  // The Playground has no anonymous surface. Every panel can spend real inference credit and every
  // request is attributed to the signed-in user, so a policy that accidentally set
  // `authenticate: false` would create unattributable spending rather than merely leaking a page.
  it('requires authentication for every policy', () => {
    for (const policy of buildAccessPolicies(AUD)) {
      expect(policy.authenticate).toBe(true);
    }
  });

  // Without an audience, signature validation alone would accept a JWT minted for any other Access
  // application in the same team, because every application in a team shares one JWKS.
  it('carries the audience on every policy', () => {
    for (const policy of buildAccessPolicies(AUD)) {
      expect(policy.audience).toBe(AUD);
    }
  });

  it.each(['/api', '/api/me', '/api/catalogue'])(
    'answers %s with a 401 rather than a login redirect',
    (path) => {
      // The single-page application's fetch calls need a JSON 401 they can render; HTML from a
      // login page would be unusable to them.
      expect(policyFor(path).redirect).toBe(false);
    }
  );

  it.each(['/', '/view-tokens', '/assets/app.js'])(
    'redirects the page navigation %s to a login form',
    (path) => {
      expect(policyFor(path).redirect).toBe(true);
    }
  );

  // A path merely starting with the letters "api" is a page, not the API.
  it('does not treat /apiary as an API path', () => {
    expect(policyFor('/apiary').redirect).toBe(true);
  });
});
