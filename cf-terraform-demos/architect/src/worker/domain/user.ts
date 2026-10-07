/**
 * @file The administrator rule. Pure: no bindings, no fetch, no storage and no identity headers, so
 *   every transport that needs to answer "is this caller the administrator?" answers it the same
 *   way — the HTTP API today, and the MCP tool layer in a later phase without a second
 *   implementation. The `users` directory's own domain type arrives in Phase 6 alongside the
 *   administrative view that reads it. Nothing in this phase reads a directory row back:
 *   authentication records one as a side effect and never consults it, which is exactly the
 *   property that keeps the directory from becoming an authorization source.
 */

/**
 * Reports whether a verified identity is this demo's single administrator.
 *
 * This is the _only_ administrator rule in the application. There is no role column, no
 * promote/demote flow and no first-user-wins bootstrap: exactly one identity is the administrator,
 * named by the operator through the `ADMIN_EMAIL` Worker variable. An attacker who could write to
 * the `users` table therefore still cannot grant themselves administrative access, because nothing
 * in that table is consulted here.
 *
 * Comparison is exact rather than case-insensitive or trimmed. An Access identity's email claim is
 * whatever the identity provider asserts, and treating two spellings as equivalent would widen the
 * set of accepted identities beyond the single value the operator configured.
 *
 * @param email Verified identity email, taken from the validated Access JWT and never from a
 *   request parameter, body or header.
 * @param adminEmail Value of the `ADMIN_EMAIL` Worker variable, or `undefined` when it is not
 *   bound.
 * @returns `true` only when `adminEmail` is a non-empty value that `email` exactly equals. An
 *   unbound or empty `ADMIN_EMAIL` makes _nobody_ an administrator, which fails closed: the
 *   alternative — treating the absent value as matching — would make every identity an
 *   administrator on a misconfigured deployment.
 */
export function isAdministrator(email: string, adminEmail: string | undefined): boolean {
  if (!adminEmail) {
    return false;
  }
  return email === adminEmail;
}
