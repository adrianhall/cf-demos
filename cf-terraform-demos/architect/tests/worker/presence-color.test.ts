import { describe, expect, it } from 'vitest';
import {
  PRESENCE_COLORS,
  presenceColorFor
} from '../../src/worker/infrastructure/presence-color.ts';

/**
 * @file Pins the small presentation-only identity→colour mapping. A random colour would make
 *   reconnects visually noisy; a client-selected one would let a caller impersonate another
 *   marker.
 */

describe('presenceColorFor', () => {
  it('returns the same colour for one identity on every call', () => {
    expect(presenceColorFor('alice@example.com')).toBe(presenceColorFor('alice@example.com'));
  });

  it('always chooses from the fixed server-side palette', () => {
    for (const email of ['alice@example.com', 'mallory@example.com', 'editor@example.com']) {
      expect(PRESENCE_COLORS).toContain(presenceColorFor(email));
    }
  });
});
