import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  clearAppliedTheme,
  clearStoredTheme,
  getStoredTheme,
  isDarkActive,
  prefersDark,
  setStoredTheme,
  THEME_STORAGE_KEY
} from '../../src/client/lib/theme.ts';

/**
 * Replaces `window.matchMedia` with a stub reporting a fixed preference.
 *
 * @param matches Whether the OS reports a dark preference.
 */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches }) as MediaQueryList)
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty('color-scheme');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getStoredTheme', () => {
  it('returns null when nothing was stored, so the OS preference applies', () => {
    expect(getStoredTheme()).toBeNull();
  });

  it.each(['dark', 'light'] as const)('returns the stored %s preference', (theme) => {
    localStorage.setItem(THEME_STORAGE_KEY, theme);

    expect(getStoredTheme()).toBe(theme);
  });

  // Anything can write to `localStorage`, including an older version of this app or an unrelated
  // script on the same origin. An unrecognised value must mean "no preference" rather than being
  // passed through to `color-scheme`, where it would be an invalid CSS value.
  it.each(['sepia', '', 'DARK', 'null'])(
    'treats the unrecognised value %o as no preference',
    (value) => {
      localStorage.setItem(THEME_STORAGE_KEY, value);

      expect(getStoredTheme()).toBeNull();
    }
  );

  it('reports no preference when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });

    expect(getStoredTheme()).toBeNull();
  });
});

describe('setStoredTheme', () => {
  it('persists the preference', () => {
    setStoredTheme('dark');

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  // Private-browsing and restricted contexts can refuse a write. The in-memory override has
  // already been applied by then, so the current page is still correct and there is nothing a
  // caller could usefully do with the error.
  it('swallows a storage failure rather than breaking the toggle', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    expect(() => setStoredTheme('light')).not.toThrow();
  });
});

describe('clearStoredTheme', () => {
  it('removes an explicit preference so the OS preference applies again', () => {
    setStoredTheme('dark');
    clearStoredTheme();

    expect(getStoredTheme()).toBeNull();
  });

  it('swallows a storage failure', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });

    expect(() => clearStoredTheme()).not.toThrow();
  });
});

describe('applyTheme', () => {
  // `color-scheme` rather than a class, because `app.css` colours every surface with
  // `light-dark()`, which reads this property and nothing else.
  it.each(['dark', 'light'] as const)(
    'sets color-scheme to %s on the document element',
    (theme) => {
      applyTheme(theme);

      expect(document.documentElement.style.colorScheme).toBe(theme);
    }
  );
});

describe('clearAppliedTheme', () => {
  // Removing the property, rather than setting it to `"light dark"`, is what returns the document
  // to the `:root` rule in app.css. Setting the pair would shadow that rule with an identical
  // value and leave the element looking overridden to anything inspecting it.
  it('removes the inline override rather than restoring a pair', () => {
    applyTheme('dark');
    clearAppliedTheme();

    expect(document.documentElement.style.colorScheme).toBe('');
    expect(document.documentElement.getAttribute('style') ?? '').not.toContain('color-scheme');
  });
});

describe('prefersDark', () => {
  it.each([true, false])('reports the OS preference %s', (matches) => {
    stubMatchMedia(matches);

    expect(prefersDark()).toBe(matches);
  });

  it('reports light when the environment has no matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);

    expect(prefersDark()).toBe(false);
  });
});

describe('isDarkActive', () => {
  it('prefers an explicit stored preference over the OS preference', () => {
    stubMatchMedia(false);
    setStoredTheme('dark');

    expect(isDarkActive()).toBe(true);
  });

  it('lets an explicit light preference win over a dark OS preference', () => {
    stubMatchMedia(true);
    setStoredTheme('light');

    expect(isDarkActive()).toBe(false);
  });

  it.each([true, false])('falls back to the OS preference (%s) with nothing stored', (matches) => {
    stubMatchMedia(matches);

    expect(isDarkActive()).toBe(matches);
  });
});
