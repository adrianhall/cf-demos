import { describe, expect, it } from 'vitest';
import { buildAccessPolicies } from '../../src/access-policies';

/**
 * Stand-in Access Audience tag; only its propagation matters here, not its value.
 */
const AUDIENCE = 'a'.repeat(64);

/**
 * Resolve a path against the policy list the same way the middleware does: first match wins.
 *
 * @param path Request pathname to evaluate.
 * @returns The matching policy.
 * @throws {Error} When no policy matches, which would mean a request the Worker cannot classify.
 */
function policyFor(path: string) {
  const policy = buildAccessPolicies(AUDIENCE).find((candidate) => candidate.pattern.test(path));
  if (policy === undefined) {
    throw new Error(`No policy matched ${path}`);
  }
  return policy;
}

describe('buildAccessPolicies', () => {
  it('has no public policy, because this demo exposes no anonymous surface', () => {
    // Unlike the sibling `link` demo there is no bypass entry. If one were ever added by accident,
    // this assertion is what would catch it.
    expect(buildAccessPolicies(AUDIENCE).every((policy) => policy.authenticate)).toBe(true);
  });

  it('stamps every policy with the audience it was built for', () => {
    // The audience is the cross-application replay defence. A policy missing it would fall back to
    // accepting any token the team's shared JWKS can verify.
    for (const policy of buildAccessPolicies(AUDIENCE)) {
      expect(policy.audience).toBe(AUDIENCE);
    }
  });

  it.each(['/graphql', '/graphql/', '/graphql?query=%7Bfilms%7D'])(
    'requires authentication for %s',
    (path) => {
      expect(policyFor(path).authenticate).toBe(true);
    }
  );

  it('answers an unauthenticated GraphQL request with a status rather than a login page', () => {
    // GraphiQL calls this endpoint with fetch. HTML from a login redirect would arrive as an
    // unparseable GraphQL response; a 401 is something the console can display.
    expect(policyFor('/graphql').redirect).toBe(false);
  });

  it('redirects an unauthenticated page navigation to a login form', () => {
    expect(policyFor('/').redirect).toBe(true);
  });

  it('requires authentication for the root, which redirects to the console', () => {
    expect(policyFor('/').authenticate).toBe(true);
  });

  it('requires authentication for any unanticipated path', () => {
    // The catch-all matters: a future route added without a policy of its own inherits
    // authentication rather than becoming silently public.
    expect(policyFor('/some/future/editor/route').authenticate).toBe(true);
  });

  it('does not let a lookalike path escape the GraphQL policy', () => {
    // `/graphqlx` must not match the GraphQL entry. It still authenticates via the catch-all, but
    // as a page, which is the correct classification for something that is not the API.
    expect(policyFor('/graphqlx').redirect).toBe(true);
  });
});
