import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DETAILS_PANEL_EXPANDED_STORAGE_KEY,
  getStoredDetailsPanelExpanded,
  setStoredDetailsPanelExpanded
} from '../../src/client/lib/details-panel-preferences.ts';
import {
  getStoredCollapsedCategories,
  PALETTE_COLLAPSED_STORAGE_KEY,
  setStoredCollapsedCategories
} from '../../src/client/lib/palette-preferences.ts';

/**
 * @file Covers the editor's two stored preferences. Both are read on mount and written on every
 *   change, so the cases that matter are the ones a happy path never reaches: nothing stored yet,
 *   something stored that is no longer valid, and storage that refuses to answer at all. A private
 *   browsing context throws on the first `localStorage` touch, and an editor that failed to open
 *   because of a preference would be a poor trade for remembering a collapsed category.
 */

beforeEach(() => {
  localStorage.clear();
});

describe('getStoredCollapsedCategories', () => {
  // Compute holds Workers, Durable Objects and Workflows, which is where a new diagram nearly
  // always starts. Expanding only that category makes the first screen of the palette useful
  // without scrolling past five other sections.
  it('seeds every category except compute as collapsed when nothing is stored', () => {
    expect(getStoredCollapsedCategories()).toEqual({
      ai: true,
      compute: false,
      external: true,
      media: true,
      network: true,
      storage: true
    });
  });

  it('honours a stored list', () => {
    localStorage.setItem(PALETTE_COLLAPSED_STORAGE_KEY, JSON.stringify(['storage', 'ai']));

    expect(getStoredCollapsedCategories()).toEqual({
      ai: true,
      compute: false,
      external: false,
      media: false,
      network: false,
      storage: true
    });
  });

  // The stored value is a list of collapsed categories rather than a map of every category's
  // state, so "stored as empty" and "never stored" are genuinely different: the first means the
  // visitor expanded everything, and must not be overwritten by the seeded default.
  it('treats an explicitly empty stored list as every category expanded', () => {
    localStorage.setItem(PALETTE_COLLAPSED_STORAGE_KEY, JSON.stringify([]));

    expect(getStoredCollapsedCategories()).toEqual({
      ai: false,
      compute: false,
      external: false,
      media: false,
      network: false,
      storage: false
    });
  });

  it('discards a category the catalogue no longer defines', () => {
    localStorage.setItem(
      PALETTE_COLLAPSED_STORAGE_KEY,
      JSON.stringify(['storage', 'not-a-category'])
    );

    const collapsed = getStoredCollapsedCategories();

    expect(collapsed.storage).toBe(true);
    expect(Object.keys(collapsed)).not.toContain('not-a-category');
  });

  it.each([
    ['a stored object rather than an array', JSON.stringify({ storage: true })],
    ['a value that is not JSON at all', 'not json']
  ])('falls back to the seeded default for %s', (_description, stored) => {
    localStorage.setItem(PALETTE_COLLAPSED_STORAGE_KEY, stored);

    expect(getStoredCollapsedCategories().compute).toBe(false);
    expect(getStoredCollapsedCategories().storage).toBe(true);
  });

  it('falls back to the seeded default when storage refuses to be read', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(getStoredCollapsedCategories().compute).toBe(false);
    spy.mockRestore();
  });
});

describe('setStoredCollapsedCategories', () => {
  it('persists only the collapsed categories', () => {
    setStoredCollapsedCategories({ ai: false, compute: true, storage: true });

    expect(JSON.parse(localStorage.getItem(PALETTE_COLLAPSED_STORAGE_KEY) ?? '[]')).toEqual([
      'compute',
      'storage'
    ]);
  });

  it('round-trips through the reader', () => {
    setStoredCollapsedCategories({ media: true, network: true });

    expect(getStoredCollapsedCategories()).toEqual({
      ai: false,
      compute: false,
      external: false,
      media: true,
      network: true,
      storage: false
    });
  });

  // The caller has already applied the change in memory, so a failed write costs the visitor the
  // preference on their next visit and nothing more.
  it('swallows a storage write failure', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(() => setStoredCollapsedCategories({ compute: true })).not.toThrow();
    spy.mockRestore();
  });
});

describe('details panel width preference', () => {
  it('defaults to compact when nothing is stored', () => {
    expect(getStoredDetailsPanelExpanded()).toBe(false);
  });

  it('round-trips an expanded preference', () => {
    setStoredDetailsPanelExpanded(true);

    expect(localStorage.getItem(DETAILS_PANEL_EXPANDED_STORAGE_KEY)).toBe('true');
    expect(getStoredDetailsPanelExpanded()).toBe(true);
  });

  it('round-trips a compact preference', () => {
    setStoredDetailsPanelExpanded(true);
    setStoredDetailsPanelExpanded(false);

    expect(getStoredDetailsPanelExpanded()).toBe(false);
  });

  // Anything other than the exact string this module writes is treated as absent, so a value left
  // behind by some other version of the application cannot put the panel in a state it has no UI
  // for.
  it('treats an unrecognised stored value as compact', () => {
    localStorage.setItem(DETAILS_PANEL_EXPANDED_STORAGE_KEY, 'yes');

    expect(getStoredDetailsPanelExpanded()).toBe(false);
  });

  it('falls back to compact when storage refuses to be read', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(getStoredDetailsPanelExpanded()).toBe(false);
    spy.mockRestore();
  });

  it('swallows a storage write failure', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(() => setStoredDetailsPanelExpanded(true)).not.toThrow();
    spy.mockRestore();
  });
});
