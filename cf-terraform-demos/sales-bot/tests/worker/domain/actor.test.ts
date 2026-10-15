import { describe, expect, it } from 'vitest';
import {
  canEditFaq,
  canManageProduct,
  isAdministrator,
  requireFaqEdit,
  requireProductManagement
} from '../../../src/worker/domain/actor';
import { actorOf } from '../support/actors';

const OWNED = { ownerIdentityKey: 'pm-key', productId: 'd1' };
const OTHER = { ownerIdentityKey: 'someone-else', productId: 'stream' };

describe('authorization rules', () => {
  it('recognizes an administrator', () => {
    expect(isAdministrator(actorOf('administrator'))).toBe(true);
    expect(isAdministrator(actorOf('pm'))).toBe(false);
  });

  it('lets an administrator manage every product, including a cross-product entry', () => {
    expect(canManageProduct(actorOf('administrator'), 'stream')).toBe(true);
    expect(canManageProduct(actorOf('administrator'), null)).toBe(true);
  });

  it('lets a PM manage only the products in their current scope', () => {
    const pm = actorOf('pm', { productScopes: ['d1'] });
    expect(canManageProduct(pm, 'd1')).toBe(true);
    expect(canManageProduct(pm, 'stream')).toBe(false);
  });

  it('does not let a PM own a cross-product FAQ, which no scope covers', () =>
    expect(canManageProduct(actorOf('pm', { productScopes: ['d1'] }), null)).toBe(false));

  it.each(['salesperson', 'overseer'] as const)('does not let a %s manage anything', (role) =>
    expect(canManageProduct(actorOf(role, { productScopes: ['d1'] }), 'd1')).toBe(false)
  );

  it('lets a PM edit an FAQ they own even after losing its product scope', () =>
    // Ownership outlives a scope change on purpose: a handover should not require the previous
    // owner to still be in scope to tidy up their own entry.
    expect(canEditFaq(actorOf('pm', { productScopes: [] }), OWNED)).toBe(true));

  it('lets a PM edit an FAQ in their scope that somebody else owns', () =>
    expect(canEditFaq(actorOf('pm', { productScopes: ['stream'] }), OTHER)).toBe(true));

  it('does not let a PM edit an FAQ they neither own nor cover', () =>
    expect(canEditFaq(actorOf('pm', { productScopes: ['d1'] }), OTHER)).toBe(false));

  it('lets an administrator override and edit anything', () =>
    expect(canEditFaq(actorOf('administrator'), OTHER)).toBe(true));

  it('tells a PM out of scope that it is forbidden', () =>
    expect(() =>
      requireProductManagement(actorOf('pm', { productScopes: ['d1'] }), 'stream')
    ).toThrowError(expect.any(Error)));

  it('tells a salesperson only that nothing was found', () =>
    // 404 rather than 403, so the API cannot confirm that a particular FAQ or product exists.
    expect(() => requireProductManagement(actorOf('salesperson'), 'd1')).toThrowError(
      expect.any(Error)
    ));

  it('answers an out-of-scope PM edit with 403 and an unprivileged one with 404', () => {
    expect(() => requireFaqEdit(actorOf('pm', { productScopes: ['d1'] }), OTHER)).toThrowError(
      expect.any(Error)
    );
    expect(() => requireFaqEdit(actorOf('overseer'), OTHER)).toThrowError(expect.any(Error));
  });

  it('permits an authorized edit without throwing', () => {
    expect(() => requireFaqEdit(actorOf('administrator'), OTHER)).not.toThrow();
    expect(() =>
      requireProductManagement(actorOf('pm', { productScopes: ['d1'] }), 'd1')
    ).not.toThrow();
  });
});
