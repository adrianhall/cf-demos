/**
 * @file Client-only colour-scheme preference, backed by `localStorage`. `../app.css` colours every
 *   surface with the CSS `light-dark()` function driven by the `color-scheme` property (`:root {
 *   color-scheme: light dark; }`) rather than a `.dark` class toggle over hand-maintained dark-mode
 *   variable overrides. Overriding the OS preference therefore means setting an explicit
 *   `color-scheme` value on `<html>`, not toggling a class — {@link applyTheme} is the one place
 *   that happens. Every reader of the stored preference should go through this module, so a test
 *   can mock a single import instead of stubbing the global `localStorage` object directly.
 */

/**
 * `localStorage` key used to persist the colour-scheme preference. Kept in sync with the `main.tsx`
 * startup logic that applies it before the app's first render.
 */
export const THEME_STORAGE_KEY = 'theme';

/**
 * A user-selected, explicit colour-scheme preference.
 *
 * There is deliberately no `"system"` member: following the OS preference is the absence of a
 * stored value, not a third stored value.
 */
export type Theme = 'dark' | 'light';

/**
 * Reads the persisted theme preference.
 *
 * @returns `"dark"` or `"light"` if an explicit preference was stored, or `null` if none was — in
 *   which case the OS preference via `prefers-color-scheme` still applies, unaffected.
 */
export function getStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    /* localStorage may be unavailable (e.g. a restricted or private-browsing context). */
    return null;
  }
}

/**
 * Persists an explicit theme preference.
 *
 * Silently swallows storage errors so callers do not need their own try/catch — the in-memory
 * `<html>` override {@link applyTheme} already made still takes effect for the current page.
 *
 * @param theme Preference to persist.
 * @returns Nothing. The write is best-effort by design.
 */
export function setStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* Restricted or private-browsing context; nothing further to do. */
  }
}

/**
 * Clears any explicit theme preference, returning the document to the OS preference.
 *
 * @returns Nothing. The removal is best-effort, as in {@link setStoredTheme}.
 */
export function clearStoredTheme(): void {
  try {
    localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    /* Restricted or private-browsing context; nothing further to do. */
  }
}

/**
 * Applies an explicit colour-scheme override to the document, taking effect immediately for every
 * `light-dark()` value in `../app.css`.
 *
 * @param theme Scheme to force, regardless of the OS preference.
 * @returns Nothing.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.style.colorScheme = theme;
}

/**
 * Removes an explicit colour-scheme override, so the document follows the OS preference again.
 *
 * Clearing the inline property rather than setting `"light dark"` is deliberate: the latter would
 * shadow the `:root` rule in `../app.css` with an identical value, leaving the document in a state
 * that looks overridden to anything inspecting the element.
 *
 * @returns Nothing.
 */
export function clearAppliedTheme(): void {
  document.documentElement.style.removeProperty('color-scheme');
}

/**
 * Reports whether the OS/browser's own preference is currently dark, ignoring any stored override.
 *
 * @returns `true` when the OS reports a dark preference, and `false` when it reports light or when
 *   the environment has no `matchMedia` (a non-browser test environment, for instance).
 */
export function prefersDark(): boolean {
  return (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/**
 * Reports whether dark mode is currently in effect: the stored preference if the user explicitly
 * set one, otherwise the OS preference.
 *
 * @returns `true` when the rendered document is dark.
 */
export function isDarkActive(): boolean {
  const stored = getStoredTheme();
  return stored ? stored === 'dark' : prefersDark();
}
