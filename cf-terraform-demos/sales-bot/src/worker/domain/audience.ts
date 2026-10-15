import type { Role } from './role';

/**
 * Audience classification attached to every FAQ, ordered from least to most restricted.
 *
 * The order matters: it is the whole policy. A reader cleared for one level may read that level and
 * everything less restricted, and nothing more.
 */
export const AUDIENCES = ['public', 'customer', 'nda', 'internal'] as const;

/**
 * Who a piece of knowledge may be shown to.
 */
export type Audience = (typeof AUDIENCES)[number];

/**
 * Restrictiveness rank of each audience. Exported as a lookup rather than derived from
 * {@link AUDIENCES} at each call site so the comparison is a single integer test and the ordering is
 * stated in exactly one place.
 */
const AUDIENCE_RANK: Record<Audience, number> = {
  public: 0,
  customer: 1,
  nda: 2,
  internal: 3
};

/**
 * Clearance given to a verified identity whose administrator has not set one explicitly.
 *
 * This is the fail-closed default required by the specification. A salesperson is deliberately
 * capped at `customer`: being signed in proves the person is a Cloudflare employee, not that they
 * are cleared for NDA or internal-only material. A PM, overseer, or administrator manages the
 * knowledge base itself and therefore has to be able to read all of it.
 *
 * An administrator raises an individual's clearance through the `identities.audience_clearance`
 * column. Nothing in a request can change it.
 *
 * @param role Verified role resolved from D1.
 * @returns The most restricted audience this role may read without an explicit clearance.
 */
export function defaultClearanceForRole(role: Role): Audience {
  return role === 'salesperson' ? 'customer' : 'internal';
}

/**
 * Answer whether a reader cleared to one audience may see content classified at another.
 *
 * @param clearance Reader's effective clearance, resolved from D1 and never from a request.
 * @param audience Audience classification stored on the content.
 * @returns Whether the content is within the reader's clearance.
 */
export function isAudienceVisible(clearance: Audience, audience: Audience): boolean {
  return AUDIENCE_RANK[audience] <= AUDIENCE_RANK[clearance];
}

/**
 * List every audience a reader may see, most permissive first.
 *
 * Repositories use this to build an `IN (...)` predicate so the filter runs in SQL rather than
 * being applied after rows have already been read into the Worker. The same list is applied again
 * immediately before delivery, as the specification requires, because a clearance can change
 * between a retrieval and the answer that quotes it.
 *
 * @param clearance Reader's effective clearance.
 * @returns The visible audiences, always containing at least `public`.
 */
export function visibleAudiences(clearance: Audience): Audience[] {
  return AUDIENCES.filter((audience) => isAudienceVisible(clearance, audience));
}

/**
 * Narrow an untrusted value to an {@link Audience}.
 *
 * @param value Candidate value, typically a column read back from D1 or a validated request field.
 * @returns Whether the value is one of the four defined audiences.
 */
export function isAudience(value: unknown): value is Audience {
  return typeof value === 'string' && (AUDIENCES as readonly string[]).includes(value);
}
