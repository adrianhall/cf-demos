/**
 * Deterministic presence-color assignment (docs/09C-COLLABORATIVE-EDITING.md's Phase 19,
 * "Decision B"). Every connecting identity is assigned a stable-for-the-session display color
 * from a small fixed palette, reused for that identity's presence avatar, cursor, and selection
 * highlight -- the same email always produces the same color, with no persisted preference and
 * no client-side computation at all (the client only ever renders whatever `color` string
 * arrives in a `presence_snapshot`/`presence_joined`/`operation`-adjacent message).
 *
 * The palette is deliberately distinct from `../../catalog.ts`'s `CATEGORY_COLORS`: those colors
 * already mean something specific on this canvas (a node's *category*), and reusing them here
 * would make a collaborator's cursor look like it was making a claim about node category. Each
 * color below was chosen for a WCAG 1.4.11-style ≥3:1 contrast ratio against *both* this app's
 * light (`#ffffff`) and dark (`#1c1c1e`, `../app.css`'s `--cf-surface` dark value) canvas
 * backgrounds -- unlike `CATEGORY_COLORS`, which is only documented as validated against a white
 * canvas -- since a presence color must stay legible as a cursor dot, a small avatar background,
 * and a selection-outline border in either theme.
 */

/**
 * Fixed presence-color palette, 7 entries spanning well-separated hues (~45° apart) so
 * adjacent identities are visually distinguishable, including for common forms of color vision
 * deficiency. Each hex value clears roughly 4:1 contrast against both `#ffffff` and `#1c1c1e`
 * (computed via the WCAG relative-luminance formula) -- comfortably above the 3:1 non-text
 * minimum in either theme, with headroom for a thin 1-2px outline/dot rendering at small sizes.
 */
export const PRESENCE_COLOR_PALETTE: readonly string[] = [
  "#E83C2C", // crimson
  "#A5731D", // amber
  "#198F54", // emerald
  "#188B87", // teal
  "#127FDE", // azure
  "#9056E1", // violet
  "#E12D9F", // magenta
];

/**
 * Deterministically hash an email to a stable index into {@link PRESENCE_COLOR_PALETTE}.
 *
 * A plain sum-of-char-codes-mod-length hash, not a real hash algorithm -- this only needs to be
 * stable (the same email always yields the same index) and reasonably spread across different
 * emails, not cryptographically sound or collision-resistant, so the simplest option that
 * satisfies those two properties is the right one for a demo.
 *
 * @param email The connecting identity's email.
 * @returns An index in `[0, PRESENCE_COLOR_PALETTE.length)`.
 */
export function hashEmailToColorIndex(email: string): number {
  let sum = 0;
  for (let i = 0; i < email.length; i++) {
    sum += email.charCodeAt(i);
  }
  return sum % PRESENCE_COLOR_PALETTE.length;
}

/**
 * Resolve the stable presence color for one identity.
 *
 * @param email The connecting identity's email.
 * @returns One of {@link PRESENCE_COLOR_PALETTE}'s hex strings, stable for this exact email.
 */
export function colorForEmail(email: string): string {
  return PRESENCE_COLOR_PALETTE[hashEmailToColorIndex(email)] as string;
}
