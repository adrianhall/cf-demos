/**
 * @file Deterministic colour assignment for live diagram presence. Presence colour is deliberately
 *   derived, not chosen or persisted. The same verified email gets the same colour whenever it is
 *   connected to this session, while D1 remains responsible only for diagram data. These hues are
 *   separate from catalogue category colours: a person's cursor must not imply anything about the
 *   type of service it happens to cross.
 */

/**
 * Small, high-contrast palette for collaborator avatars, cursors and selection outlines.
 */
export const PRESENCE_COLORS = [
  '#b42318',
  '#9a6700',
  '#087443',
  '#087f8c',
  '#1565c0',
  '#6f42c1',
  '#b51d7b'
] as const;

/**
 * Resolves the stable display colour for one verified identity.
 *
 * This deliberately simple non-cryptographic hash needs only a stable, reasonably distributed
 * palette index. Authentication already established the email; colour assignment is presentation,
 * not a security decision.
 *
 * @param email Verified Access identity.
 * @returns One colour from {@link PRESENCE_COLORS}.
 */
export function presenceColorFor(email: string): string {
  let hash = 0;
  for (const character of email) {
    hash = (hash + character.charCodeAt(0)) % PRESENCE_COLORS.length;
  }
  return PRESENCE_COLORS[hash] as string;
}
