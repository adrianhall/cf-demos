import { describe, expect, it } from 'vitest';
import { isAdministrator } from '../../src/worker/domain/user.ts';

/**
 * @file The administrator rule is the whole of this demo's privileged-access decision, and it is a
 *   pure function precisely so it can be tested exhaustively here rather than only observed through
 *   an HTTP status. Every case below describes an identity the deployed application must or must
 *   not treat as the administrator.
 */

const ADMIN = 'admin@example.com';

describe('isAdministrator', () => {
  it('recognises the configured administrator', () => {
    expect(isAdministrator(ADMIN, ADMIN)).toBe(true);
  });

  it('rejects an ordinary identity', () => {
    expect(isAdministrator('alice@example.com', ADMIN)).toBe(false);
  });

  // Fails closed. A deployment whose `ADMIN_EMAIL` was never bound must have *no* administrator,
  // not every identity as one — which is what a truthiness check on the identity alone would do.
  it.each([undefined, ''])('makes nobody an administrator when ADMIN_EMAIL is %o', (adminEmail) => {
    expect(isAdministrator(ADMIN, adminEmail)).toBe(false);
    expect(isAdministrator('alice@example.com', adminEmail)).toBe(false);
  });

  // An empty verified email cannot be manufactured by a caller — it comes from a validated JWT —
  // but an empty configured value must not match it either, or an unset variable plus a malformed
  // token would combine into administrative access.
  it('does not match an empty identity against an empty configured value', () => {
    expect(isAdministrator('', '')).toBe(false);
  });

  // Exact comparison, deliberately. An identity provider asserts whatever spelling it asserts, and
  // treating two spellings as equivalent would widen the accepted set beyond the single value the
  // operator configured.
  it.each(['Admin@example.com', 'ADMIN@EXAMPLE.COM', 'admin@Example.com'])(
    'does not treat %s as the configured administrator',
    (email) => {
      expect(isAdministrator(email, ADMIN)).toBe(false);
    }
  );

  it.each([' admin@example.com', 'admin@example.com ', 'admin@example.com\t'])(
    'does not treat the whitespace-padded %o as the configured administrator',
    (email) => {
      expect(isAdministrator(email, ADMIN)).toBe(false);
    }
  );

  // A prefix or suffix of the configured address is a different address. This is the shape a
  // `startsWith`/`includes` comparison would wrongly admit.
  it.each(['admin@example.com.attacker.test', 'xadmin@example.com', 'admin@example.co'])(
    'does not treat the similar address %s as the configured administrator',
    (email) => {
      expect(isAdministrator(email, ADMIN)).toBe(false);
    }
  );
});
