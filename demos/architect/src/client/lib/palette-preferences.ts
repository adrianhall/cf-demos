/**
 * Client-only service-palette category collapse/expand preference, backed by `localStorage`.
 *
 * Bug 32 (docs/09-ARCHITECT.md Phase 10): `../components/editor/panels/ServicePalette.tsx`
 * previously started every category expanded on every editor open, with no memory of a user's
 * previous session. This module mirrors `./theme.ts`'s centralization pattern (a single module
 * every reader/writer goes through, `try`/`catch` around every storage call so a restricted or
 * private-browsing context degrades silently) so a test can mock one import instead of stubbing
 * the global `localStorage` object directly.
 *
 * The preference is a single flat list of *collapsed* category ids (not a map of every
 * category's open/closed state) so a newly added catalog category with no prior stored
 * preference defaults to expanded, matching every other pre-existing category's original
 * behavior before this bug was ever filed.
 */
import type { NodeCategory } from "../../catalog";

/** `localStorage` key used to persist the palette's collapsed-category list. */
export const PALETTE_COLLAPSED_STORAGE_KEY = "palette-collapsed-categories";

/** Every known catalog category, used both to validate stored data and to compute the seeded
 * default below. Kept in sync with `../../catalog.ts`'s `NodeCategory` union. */
const ALL_CATEGORIES: NodeCategory[] = [
  "compute",
  "storage",
  "ai",
  "media",
  "network",
  "external",
];

/** Categories collapsed by default on a user's very first visit, before any preference has ever
 * been stored: every category except "compute" (docs/09-ARCHITECT.md Phase 10's Bug 32 "short
 * fix" suggestion), since Compute (Workers, Durable Objects, Workflows, ...) is the most likely
 * starting point for a new diagram. */
const DEFAULT_COLLAPSED: NodeCategory[] = ALL_CATEGORIES.filter(
  (category) => category !== "compute",
);

/**
 * Read the persisted set of collapsed categories.
 *
 * @returns A record keyed by every {@link NodeCategory}, `true` where that category is
 * collapsed. Falls back to {@link DEFAULT_COLLAPSED} (seeded, not empty) when nothing valid has
 * ever been stored, `localStorage` is unavailable, or the stored value is malformed.
 */
export function getStoredCollapsedCategories(): Record<NodeCategory, boolean> {
  const collapsedList = readStoredList() ?? DEFAULT_COLLAPSED;
  return Object.fromEntries(
    ALL_CATEGORIES.map((category) => [
      category,
      collapsedList.includes(category),
    ]),
  ) as Record<NodeCategory, boolean>;
}

/**
 * Persist the current set of collapsed categories.
 *
 * Silently swallows storage errors so callers don't need their own `try`/`catch` — the in-memory
 * state the caller already applied still takes effect for the current page.
 *
 * @param collapsed The same shape {@link getStoredCollapsedCategories} returns; only entries
 * whose value is truthy are written.
 */
export function setStoredCollapsedCategories(
  collapsed: Record<string, boolean>,
): void {
  try {
    const collapsedList = ALL_CATEGORIES.filter(
      (category) => collapsed[category],
    );
    localStorage.setItem(
      PALETTE_COLLAPSED_STORAGE_KEY,
      JSON.stringify(collapsedList),
    );
  } catch {
    /* restricted or private-browsing context; nothing further to do. */
  }
}

/**
 * Read and validate the raw stored list, without applying the seeded default -- kept separate
 * from {@link getStoredCollapsedCategories} so "nothing valid stored" and "explicitly stored as
 * empty" both fall through to that function's single default-substitution point.
 *
 * @returns The stored category list filtered to known {@link NodeCategory} values, or `null` if
 * nothing was stored, `localStorage` is unavailable, or the stored value isn't a JSON array.
 */
function readStoredList(): NodeCategory[] | null {
  try {
    const raw = localStorage.getItem(PALETTE_COLLAPSED_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((value): value is NodeCategory =>
      ALL_CATEGORIES.includes(value as NodeCategory),
    );
  } catch {
    /* localStorage may be unavailable, or the stored value may not be valid JSON. */
    return null;
  }
}
