import { describe, expect, it } from 'vitest';
import {
  AUDIENCES,
  defaultClearanceForRole,
  isAudience,
  isAudienceVisible,
  visibleAudiences,
  type Audience
} from '../../../src/worker/domain/audience';
import type { Role } from '../../../src/worker/domain/role';

describe('audience policy', () => {
  it('orders audiences from least to most restricted', () =>
    expect([...AUDIENCES]).toEqual(['public', 'customer', 'nda', 'internal']));

  it.each<[Role, Audience]>([
    ['salesperson', 'customer'],
    ['pm', 'internal'],
    ['overseer', 'internal'],
    ['administrator', 'internal']
  ])('gives %s the %s default clearance', (role, expected) =>
    expect(defaultClearanceForRole(role)).toBe(expected)
  );

  it('lets a reader see their own level and everything less restricted', () => {
    expect(visibleAudiences('nda')).toEqual(['public', 'customer', 'nda']);
    expect(visibleAudiences('public')).toEqual(['public']);
  });

  it('never hides public content from anyone', () =>
    expect(AUDIENCES.every((clearance) => isAudienceVisible(clearance, 'public'))).toBe(true));

  it('keeps internal content from a default salesperson clearance', () =>
    expect(isAudienceVisible(defaultClearanceForRole('salesperson'), 'internal')).toBe(false));

  it('keeps NDA content from a default salesperson clearance', () =>
    expect(isAudienceVisible(defaultClearanceForRole('salesperson'), 'nda')).toBe(false));

  it.each(['', 'secret', 'INTERNAL', null, 7])('rejects %p as an audience', (value) =>
    expect(isAudience(value)).toBe(false)
  );

  it('accepts every defined audience', () =>
    expect(AUDIENCES.every((audience) => isAudience(audience))).toBe(true));
});
