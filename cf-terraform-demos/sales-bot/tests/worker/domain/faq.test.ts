import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPIRY_DAYS,
  defaultExpiry,
  isFaqRetrievable,
  type FaqStatus
} from '../../../src/worker/domain/faq';

const NOW = new Date('2026-10-15T12:00:00.000Z');

describe('FAQ lifecycle', () => {
  it(`defaults a new publication to ${DEFAULT_EXPIRY_DAYS} days`, () =>
    expect(defaultExpiry(NOW)).toBe('2027-01-13T12:00:00.000Z'));

  it('retrieves an active FAQ with a future expiry', () =>
    expect(isFaqRetrievable({ status: 'active', expiresAt: '2026-12-01T00:00:00.000Z' }, NOW)).toBe(
      true
    ));

  it('retrieves an active FAQ whose expiry was deliberately removed', () =>
    expect(isFaqRetrievable({ status: 'active', expiresAt: null }, NOW)).toBe(true));

  it('excludes an FAQ whose expiry has passed even while it is still marked active', () =>
    // This is the invariant the specification calls out: retrieval must not depend on the
    // scheduled expiry marker having run.
    expect(isFaqRetrievable({ status: 'active', expiresAt: '2026-10-15T11:59:59.999Z' }, NOW)).toBe(
      false
    ));

  it('excludes an FAQ expiring exactly now', () =>
    expect(isFaqRetrievable({ status: 'active', expiresAt: '2026-10-15T12:00:00.000Z' }, NOW)).toBe(
      false
    ));

  it.each<FaqStatus>(['archived', 'expired'])(
    'excludes a %s FAQ regardless of its date',
    (status) => expect(isFaqRetrievable({ status, expiresAt: null }, NOW)).toBe(false)
  );
});
