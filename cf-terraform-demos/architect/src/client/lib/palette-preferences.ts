import type { NodeCategory } from '../../catalog.ts';

/**
 * @file The service palette's collapsed-category preference, backed by `localStorage`. Every read
 *   and write goes through this module for the same reason `./theme.ts` exists: one place wraps
 *   storage in `try`/`catch`, so a restricted or private-browsing context degrades to the default
 *   instead of throwing while the editor mounts, and a test can replace one import rather than the
 *   global object.
 */

/**
 * `localStorage` key holding the collapsed-category list.
 */
export const PALETTE_COLLAPSED_STORAGE_KEY = 'palette-collapsed-categories';

/**
 * Every catalogue category, used both to validate a stored value and to build the default.
 *
 * Kept in step with `../../catalog.ts`'s `NodeCategory`; a category added there but not here is
 * simply never persisted, which shows up as a section that forgets its state rather than as a
 * crash.
 */
const ALL_CATEGORIES: NodeCategory[] = ['compute', 'storage', 'ai', 'media', 'network', 'external'];

/**
 * Categories collapsed on a first visit: everything except compute.
 *
 * Six expanded sections of 42 products puts the palette's useful content below the fold. Compute
 * holds Workers, Durable Objects and Workflows, which is where a Cloudflare diagram nearly always
 * starts, so opening that one alone makes the first screen worth reading.
 */
const DEFAULT_COLLAPSED: NodeCategory[] = ALL_CATEGORIES.filter(
  (category) => category !== 'compute'
);

/**
 * Reads and validates the raw stored list, without substituting the default.
 *
 * Separate from {@link getStoredCollapsedCategories} so that "nothing valid stored" and
 * "deliberately stored as empty" stay distinguishable: the first takes the default, while the
 * second means the visitor expanded everything and must be honoured.
 *
 * @returns The stored categories, filtered to ones the catalogue still defines, or `null` when
 *   nothing was stored, storage is unavailable, or the value is not a JSON array.
 */
function readStoredList(): NodeCategory[] | null {
  try {
    const raw = localStorage.getItem(PALETTE_COLLAPSED_STORAGE_KEY);
    if (raw === null) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter((value): value is NodeCategory =>
      ALL_CATEGORIES.includes(value as NodeCategory)
    );
  } catch {
    /* Storage is unavailable, or the stored value is not valid JSON. */
    return null;
  }
}

/**
 * Reads which palette categories should start collapsed.
 *
 * @returns One entry per category, `true` where it is collapsed. Falls back to the seeded default
 *   when nothing valid has been stored.
 */
export function getStoredCollapsedCategories(): Record<NodeCategory, boolean> {
  const collapsedList = readStoredList() ?? DEFAULT_COLLAPSED;

  return Object.fromEntries(
    ALL_CATEGORIES.map((category) => [category, collapsedList.includes(category)])
  ) as Record<NodeCategory, boolean>;
}

/**
 * Persists which palette categories are collapsed.
 *
 * A list of the collapsed ones rather than a map of every category's state, so a category added to
 * the catalogue later has no stored entry and therefore starts expanded — the behaviour a new
 * section should have, instead of inheriting whatever a stale map happened to say.
 *
 * Storage failures are swallowed: the caller has already applied the change in memory, so the cost
 * is the preference not surviving to the next visit.
 *
 * @param collapsed Collapsed state by category; only truthy entries are written.
 * @returns Nothing. The write is best-effort by design.
 */
export function setStoredCollapsedCategories(collapsed: Record<string, boolean>): void {
  try {
    const collapsedList = ALL_CATEGORIES.filter((category) => collapsed[category]);
    localStorage.setItem(PALETTE_COLLAPSED_STORAGE_KEY, JSON.stringify(collapsedList));
  } catch {
    /* Restricted or private-browsing context; nothing further to do. */
  }
}
