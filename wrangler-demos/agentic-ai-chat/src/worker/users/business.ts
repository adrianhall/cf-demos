/**
 * This demo's admin-settable business segment (docs/06-AGENTIC-CHAT.md Section 6.4/6.5, Phase 7,
 * US-6) -- steers `GET /api/admin/reports/by-business`'s grouping and, from Phase 8 onward, AI
 * Gateway's own metadata-driven model routing. Deliberately an application-level enum, not a D1
 * `CHECK` constraint on the `users.business` column (`../../../migrations/0003_add_users_business_geo.sql`):
 * a future added value needs only a code change here, never a migration.
 */
export type Business = "field" | "product" | "leadership";

/** Every valid {@link Business}, in the order an admin editor's dropdown should offer them. */
export const BUSINESS_VALUES: readonly Business[] = [
  "field",
  "product",
  "leadership",
];

/**
 * Narrow an arbitrary value (an admin's request body, a D1 column read back) to a
 * {@link Business} by exact match -- mirrors `../chats/route.ts`'s `isChatRoute()`, the same
 * "resolve by exact match, never trust anything else" discipline applied to a different
 * admin-settable enum.
 *
 * @param value Untyped input to check.
 * @returns Whether `value` is exactly one of {@link BUSINESS_VALUES}.
 */
export function isBusiness(value: unknown): value is Business {
  return (BUSINESS_VALUES as readonly unknown[]).includes(value);
}

/**
 * This demo's admin-settable geo segment (docs/06-AGENTIC-CHAT.md Section 6.4/6.5, Phase 7,
 * US-6). Also an application-level enum, for the same reason as {@link Business}.
 */
export type Geo = "emea" | "apac" | "americas";

/** Every valid {@link Geo}, in the order an admin editor's dropdown should offer them. */
export const GEO_VALUES: readonly Geo[] = ["emea", "apac", "americas"];

/**
 * Narrow an arbitrary value to a {@link Geo} by exact match -- see {@link isBusiness}'s own
 * rationale.
 *
 * @param value Untyped input to check.
 * @returns Whether `value` is exactly one of {@link GEO_VALUES}.
 */
export function isGeo(value: unknown): value is Geo {
  return (GEO_VALUES as readonly unknown[]).includes(value);
}
