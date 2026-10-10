/**
 * Client-only color-scheme preference, backed by `localStorage`.
 *
 * Ported from CF-Architect's `src/lib/preferences.ts` (docs/09-ARCHITECT.md Phase 5), adapted to
 * this port's theming approach: `../app.css` colors every surface with the CSS `light-dark()`
 * function driven by the `color-scheme` property (`:root { color-scheme: light dark; }`), rather
 * than CF-Architect's `.dark` class toggle over hand-maintained dark-mode variable overrides.
 * Overriding the OS preference here therefore means setting an explicit `color-scheme` value on
 * `<html>`, not toggling a class — `applyTheme()` is the one place that happens.
 *
 * Every reader of the stored preference should go through this module (matching CF-Architect's
 * own centralization rationale) so a test can mock a single import instead of stubbing the
 * global `localStorage` object directly.
 */

/** `localStorage` key used to persist the color-scheme preference. Kept in sync with the
 * `main.tsx` startup logic that applies it before the app's first render. */
export const THEME_STORAGE_KEY = "theme";

/** A user-selected, explicit color-scheme preference. */
export type Theme = "dark" | "light";

/**
 * Read the persisted theme preference.
 *
 * @returns `"dark"` or `"light"` if an explicit preference was stored, or `null` if none was
 * (the OS preference via `prefers-color-scheme` still applies in that case, unaffected).
 */
export function getStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch {
    /* localStorage may be unavailable (e.g. a restricted or private-browsing context). */
    return null;
  }
}

/**
 * Persist an explicit theme preference.
 *
 * Silently swallows storage errors so callers don't need their own try/catch — the in-memory
 * `<html>` override {@link applyTheme} already made still takes effect for the current page.
 */
export function setStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* restricted or private-browsing context; nothing further to do. */
  }
}

/**
 * Apply an explicit color-scheme override to the document, taking effect immediately for every
 * `light-dark()` value in `../app.css`.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.style.colorScheme = theme;
}

/** Whether the OS/browser's own preference is currently dark, ignoring any stored override. */
export function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/**
 * Whether dark mode is currently in effect: the stored preference if one was explicitly set by
 * the user, otherwise the OS preference.
 */
export function isDarkActive(): boolean {
  const stored = getStoredTheme();
  return stored ? stored === "dark" : prefersDark();
}
