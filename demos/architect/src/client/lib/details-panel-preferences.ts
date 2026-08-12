/**
 * Client-only details panel expand/collapse width preference, backed by `localStorage`.
 *
 * docs/09D-ARCHITECT-AICHAT.md's In-Editor Chat section: "Persisted per-user via a new
 * `src/client/lib/details-panel-preferences.ts` (mirroring `./palette-preferences.ts`'s
 * `localStorage`-backed pattern)." Only the expand/collapse width is persisted here -- the
 * active tab (`../stores/diagramStore.ts`'s `detailsPanelTab`) deliberately is not: every other
 * field in that store with no persistence of its own (e.g. `propertiesOpen`) already starts
 * fresh at its plain in-memory default on every mount, and persisting the last-active tab too
 * would fight "selection switches to Properties" (that same store's `setSelectedNode`/
 * `setSelectedEdge`) in a confusing way on a reload that happens to land mid-selection.
 */

/** `localStorage` key used to persist the details panel's expanded/collapsed preference. */
export const DETAILS_PANEL_EXPANDED_STORAGE_KEY = "details-panel-expanded";

/**
 * Read the persisted expand/collapse preference.
 *
 * @returns `true` if the panel was last left expanded, `false` (the seeded default, matching
 * `../stores/diagramStore.ts`'s `detailsPanelExpanded` default) when nothing has ever been
 * stored, `localStorage` is unavailable, or the stored value isn't the literal string this
 * module itself writes.
 */
export function getStoredDetailsPanelExpanded(): boolean {
  try {
    return localStorage.getItem(DETAILS_PANEL_EXPANDED_STORAGE_KEY) === "true";
  } catch {
    /* restricted or private-browsing context; the seeded default is exactly as good. */
    return false;
  }
}

/**
 * Persist the current expand/collapse preference.
 *
 * Silently swallows storage errors so callers don't need their own `try`/`catch` -- the
 * in-memory state the caller already applied still takes effect for the current page.
 *
 * @param expanded Whether the panel is currently expanded.
 */
export function setStoredDetailsPanelExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(
      DETAILS_PANEL_EXPANDED_STORAGE_KEY,
      expanded ? "true" : "false",
    );
  } catch {
    /* restricted or private-browsing context; nothing further to do. */
  }
}
