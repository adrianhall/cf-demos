/**
 * @file The details panel's wide/compact width preference, backed by `localStorage` and wrapped
 *   exactly as `./palette-preferences.ts` and `./theme.ts` are, so a context that refuses storage
 *   degrades to the default rather than throwing during the editor's first render. Only the width
 *   is persisted. Which node or edge is selected, and whether the panel is open at all, are
 *   in-memory state that starts fresh on every load — a remembered selection would point at an
 *   element the diagram being opened may not contain.
 */

/**
 * `localStorage` key holding the wide/compact preference.
 */
export const DETAILS_PANEL_EXPANDED_STORAGE_KEY = 'details-panel-expanded';

/**
 * Reads the stored width preference.
 *
 * Compared against the exact string this module writes rather than coerced, so a value left behind
 * by anything else is treated as absent instead of being read as truthy.
 *
 * @returns `true` when the panel was last left wide, and `false` when it was compact, nothing has
 *   been stored, or storage is unavailable.
 */
export function getStoredDetailsPanelExpanded(): boolean {
  try {
    return localStorage.getItem(DETAILS_PANEL_EXPANDED_STORAGE_KEY) === 'true';
  } catch {
    /* Restricted or private-browsing context; the default is exactly as good. */
    return false;
  }
}

/**
 * Persists the width preference.
 *
 * Storage failures are swallowed, as in `./palette-preferences.ts`: the caller has already applied
 * the change on screen, so the cost is the preference not surviving to the next visit.
 *
 * @param expanded Whether the panel is currently wide.
 * @returns Nothing. The write is best-effort by design.
 */
export function setStoredDetailsPanelExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(DETAILS_PANEL_EXPANDED_STORAGE_KEY, expanded ? 'true' : 'false');
  } catch {
    /* Restricted or private-browsing context; nothing further to do. */
  }
}
