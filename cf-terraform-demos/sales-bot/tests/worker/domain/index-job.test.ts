import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, isAuditAction } from '../../../src/worker/domain/audit';
import {
  MAX_INDEX_ATTEMPTS,
  canRetryIndexJob,
  statusAfterFailure
} from '../../../src/worker/domain/index-job';
import {
  DEFAULT_ESCALATION_TARGET,
  escalationTargetFor,
  type Product
} from '../../../src/worker/domain/product';

describe('index-job retry budget', () => {
  it('retries while attempts remain', () => {
    expect(canRetryIndexJob(0)).toBe(true);
    expect(canRetryIndexJob(MAX_INDEX_ATTEMPTS - 1)).toBe(true);
  });

  it('stops at the attempt budget', () => {
    expect(canRetryIndexJob(MAX_INDEX_ATTEMPTS)).toBe(false);
    expect(canRetryIndexJob(MAX_INDEX_ATTEMPTS + 1)).toBe(false);
  });

  it('keeps a job pending until its attempts are exhausted, then parks it', () => {
    expect(statusAfterFailure(1)).toBe('pending');
    expect(statusAfterFailure(MAX_INDEX_ATTEMPTS)).toBe('failed');
  });
});

describe('escalation routing', () => {
  /**
   * Build a product for a routing test.
   *
   * @param escalationTarget Target the map names, or `null`.
   * @returns A product.
   */
  function productWith(escalationTarget: string | null): Product {
    return { id: 'd1', name: 'D1', primaryPm: 'Ivory Ibuaka', escalationTarget, active: true };
  }

  it('uses the configured escalation target', () =>
    expect(escalationTargetFor(productWith('Vy Ton'))).toBe('Vy Ton'));

  it('falls back for an unlisted product', () =>
    expect(escalationTargetFor(null)).toBe(DEFAULT_ESCALATION_TARGET));

  it('falls back for a listed product that names no target', () =>
    expect(escalationTargetFor(productWith(null))).toBe(DEFAULT_ESCALATION_TARGET));
});

describe('audit actions', () => {
  it('recognizes every declared action', () =>
    expect(AUDIT_ACTIONS.every((action) => isAuditAction(action))).toBe(true));

  it.each(['faq.invented', '', null, 42])('rejects %p as an action filter', (value) =>
    expect(isAuditAction(value)).toBe(false)
  );
});
