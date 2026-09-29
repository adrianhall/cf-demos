import { describe, expect, it } from 'vitest';
import { accessPolicies } from '../../../src/access-policies';

/**
 * Find the first shared Access policy matching a request path.
 */
function policyFor(path: string): (typeof accessPolicies)[number] | undefined {
  return accessPolicies.find((policy) => policy.pattern.test(path));
}

describe('Access path policies', () => {
  it.each(['/', '/_next/static/chunks/index.js', '/l', '/l/example'])(
    'allows public path %s so an unauthenticated visitor can reach it',
    (path) => {
      expect(policyFor(path)).toMatchObject({ authenticate: false });
    }
  );

  it('keeps the public root policy anchored to exactly /', () => {
    // A non-anchored /^\// pattern would make every path public, defeating defaultAction: 'block'.
    expect(policyFor('/index.html')).toBeUndefined();
    expect(policyFor('/admin')).toMatchObject({ authenticate: true });
  });

  it.each(['/admin', '/admin/settings'])(
    'redirects an unauthenticated navigation to %s',
    (path) => {
      expect(policyFor(path)).toMatchObject({
        authenticate: true,
        redirect: true
      });
    }
  );

  it.each(['/api/links/example', '/api/me'])(
    'protects the management API at %s without redirecting fetch requests',
    (path) => {
      expect(policyFor(path)).toMatchObject({
        authenticate: true,
        redirect: false
      });
    }
  );

  it('does not mistake other paths beginning with l for redirects', () => {
    expect(policyFor('/login')).toBeUndefined();
  });
});
