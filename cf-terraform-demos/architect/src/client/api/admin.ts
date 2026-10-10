import { beginAccessRecovery, takeRecoveredApiResult } from './access-recovery.ts';
import type { SharedDiagram } from './shares.ts';

/**
 * @file The browser's only route to administrative data. Every function here needs the configured
 *   administrator's Access session; an ordinary signed-in visitor receives `403` from each of them,
 *   which is the whole point — the administrative view's own visibility gate is presentation, and
 *   these are the requests that are actually refused.
 */

/**
 * One row of the administrative user directory.
 */
export interface AdminUser {
  /**
   * Verified Cloudflare Access identity email.
   */
  email: string;
  /**
   * Human-readable display name.
   *
   * Always `null` today: the verified Access identity carries no name claim and this demo
   * provisions no identity provider of its own that could supply one. The table still renders the
   * column, so the directory's documented shape is visible rather than silently dropped.
   */
  displayName: string | null;
  /**
   * ISO-8601 timestamp recorded the first time this identity authenticated.
   */
  firstSeenAt: string;
  /**
   * ISO-8601 timestamp recorded on this identity's most recent authenticated request.
   */
  lastSeenAt: string;
  /**
   * Number of diagrams this identity currently owns.
   */
  diagramCount: number;
}

/**
 * One page of the administrative user directory.
 */
export interface AdminUserPage {
  /**
   * Up to `limit` directory entries, most recently active first.
   */
  users: AdminUser[];
  /**
   * Total number of distinct identities in the directory, independent of pagination. The table
   * needs it to decide whether a next page exists, which a page of rows cannot answer.
   */
  total: number;
  /**
   * The window's size, as the server actually applied it. Echoed back rather than assumed, because
   * both parameters are optional and the server owns the defaults.
   */
  limit: number;
  /**
   * The window's starting offset, as the server actually applied it.
   */
  offset: number;
}

/**
 * The RFC 9457 members this client reads from a failed response.
 */
interface ProblemDetails {
  /**
   * Human-readable explanation, written by the server to be shown to a user.
   */
  detail?: string;
  /**
   * Short summary of the problem type.
   */
  title?: string;
}

/**
 * Message shown when the server gave nothing usable to show.
 */
const GENERIC_FAILURE = 'The request could not be completed.';

/**
 * Message shown when a response succeeded but did not carry the payload it should have.
 */
const UNEXPECTED_RESPONSE = 'The server returned an unexpected response.';

/**
 * Parses a response body as a JSON object.
 *
 * @param response Response whose body should be parsed.
 * @returns The parsed object, or `null` for an empty, malformed or non-object body.
 */
async function jsonObject(response: Response): Promise<Record<string, unknown> | null> {
  const body: unknown = await response.json().catch(() => null);
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/**
 * Converts a failed response's parsed body into an error carrying a message safe to render.
 *
 * @param body Parsed response body, or `null` when it was absent or not a JSON object.
 * @returns An error whose message can be displayed.
 */
function requestError(body: Record<string, unknown> | null): Error {
  const problem = body as ProblemDetails | null;
  return new Error(problem?.detail ?? problem?.title ?? GENERIC_FAILURE);
}

/**
 * Sends a same-origin JSON request and returns the response envelope.
 *
 * `Content-Type: application/json` is set on every call including the reads, matching
 * `./diagrams.ts` and `./shares.ts`: the Worker requires exactly that type on a mutation, and
 * setting it uniformly keeps a caller from having to remember which verbs need it.
 *
 * @param path Same-origin API path.
 * @param init Additional request options.
 * @returns The decoded response envelope.
 * @throws {Error} When the status is unsuccessful — including the `403` an identity that is not the
 *   configured administrator receives — or when a successful response's body is absent or is not a
 *   JSON object.
 */
async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const recovered = takeRecoveredApiResult(path, init);
  if (recovered !== null) {
    if (!recovered.ok) {
      throw requestError(recovered.body);
    }
    if (recovered.body === null) {
      throw new Error(UNEXPECTED_RESPONSE);
    }
    return recovered.body;
  }

  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers }
  });

  const body = await jsonObject(response);
  if (!response.ok) {
    if (response.status === 401) {
      beginAccessRecovery(path, init);
    }
    throw requestError(body);
  }

  if (body === null) {
    throw new Error(UNEXPECTED_RESPONSE);
  }
  return body;
}

/**
 * Reads one page of the user directory, most recently active identity first.
 *
 * @param options Pagination window. Both members are optional; the server applies its own defaults
 *   and reports which window it used.
 * @param options.limit Maximum number of rows to return.
 * @param options.offset Number of rows to skip before the returned page.
 * @returns The requested page, including the window the server actually applied.
 * @throws {Error} When the caller is not the configured administrator, when a pagination value is
 *   out of range, or when the response did not carry a usable page.
 */
export async function listUsers(
  options: { limit?: number; offset?: number } = {}
): Promise<AdminUserPage> {
  const parameters = new URLSearchParams();
  if (options.limit !== undefined) {
    parameters.set('limit', String(options.limit));
  }
  if (options.offset !== undefined) {
    parameters.set('offset', String(options.offset));
  }

  const query = parameters.toString();
  const body = await request(`/api/admin/users${query.length > 0 ? `?${query}` : ''}`);

  // Checked rather than cast. A well-formed but unexpected body would otherwise reach the table
  // as `undefined` and fail while rendering, with no connection to the request that caused it.
  if (!Array.isArray(body.users) || typeof body.total !== 'number') {
    throw new Error(UNEXPECTED_RESPONSE);
  }

  return {
    limit: typeof body.limit === 'number' ? body.limit : (body.users as AdminUser[]).length,
    offset: typeof body.offset === 'number' ? body.offset : 0,
    total: body.total,
    users: body.users as AdminUser[]
  };
}

/**
 * Reads any identity's diagram for moderation review.
 *
 * Returns the same owner-blind projection the anonymous share viewer receives — never the owner —
 * which is why this shares `SharedDiagram` rather than declaring a near-identical type. See the
 * Worker's `application/admin-service.ts` for why that scope is deliberate rather than unfinished.
 *
 * @param diagramId Diagram id to preview.
 * @returns The diagram's id, title, description and current graph.
 * @throws {Error} When the caller is not the configured administrator, when no diagram has that id,
 *   or when the response did not carry a diagram.
 */
export async function getAnyDiagram(diagramId: string): Promise<SharedDiagram> {
  const body = await request(`/api/admin/diagrams/${encodeURIComponent(diagramId)}`);

  if (!('diagram' in body)) {
    throw new Error(UNEXPECTED_RESPONSE);
  }
  return body.diagram as SharedDiagram;
}

/**
 * Deletes any identity's diagram — moderation, not owner self-service.
 *
 * Cascades on the server to revoke every share link to the diagram, exactly as an owner's own
 * delete does, so a moderated diagram's link can never keep resolving.
 *
 * Does not go through {@link request}: the endpoint answers `204` with no body, which
 * `response.json()` would reject.
 *
 * @param diagramId Diagram id to delete.
 * @returns A promise fulfilled once the server has deleted the diagram.
 * @throws {Error} When the caller is not the configured administrator, or no diagram has that id.
 */
export async function deleteAnyDiagram(diagramId: string): Promise<void> {
  const path = `/api/admin/diagrams/${encodeURIComponent(diagramId)}`;
  const init = { headers: { 'Content-Type': 'application/json' }, method: 'DELETE' };
  const recovered = takeRecoveredApiResult(path, init);
  if (recovered !== null) {
    if (!recovered.ok) {
      throw requestError(recovered.body);
    }
    return;
  }

  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await jsonObject(response);
    if (response.status === 401) {
      beginAccessRecovery(path, init);
    }
    throw requestError(body);
  }
}
