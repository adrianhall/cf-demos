/**
 * @file The browser's only route to share data. Two postures live here, exactly as they do on the
 *   server: the owner-scoped management calls, which require the visitor's Access session, and the
 *   anonymous resolver, which requires nothing at all. The client's part in the token rule is
 *   restraint. It carries a token from the address bar to the server and displays one the server
 *   just minted; it never hashes it, stores it, logs it or derives anything from it. Only the
 *   server holds the digest a token is compared against, so any cleverness here would be a second
 *   implementation of a rule that works precisely because it has one.
 */

/**
 * A diagram's current share state, as its owner sees it.
 *
 * Carries no link, and cannot: only a digest of the token is stored, so the server itself cannot
 * reproduce one. An owner who has lost their link creates a new one, which revokes the old.
 */
export interface ShareStatus {
  /**
   * Whether a read-only link is currently active for this diagram.
   */
  active: boolean;
  /**
   * ISO-8601 creation timestamp of the active link, or `null` when none is active.
   */
  createdAt: string | null;
}

/**
 * A newly minted share link.
 *
 * The only response in the application that carries a raw token. Show it to the owner now; nothing
 * — not this client, not the server — can produce it again.
 */
export interface CreatedShare {
  /**
   * The raw share token.
   */
  token: string;
  /**
   * The absolute, shareable URL the server assembled: `${origin}/s/${token}`.
   */
  url: string;
  /**
   * ISO-8601 creation timestamp.
   */
  createdAt: string;
}

/**
 * The read-only fields an anonymous viewer receives.
 *
 * No `ownerEmail`, by the server's construction rather than by this type's omission: a public link
 * must never disclose whose diagram it points at.
 */
export interface SharedDiagram {
  /**
   * Diagram id.
   */
  id: string;
  /**
   * Diagram title.
   */
  title: string;
  /**
   * Diagram description, or `null`.
   */
  description: string | null;
  /**
   * The diagram's current graph, JSON-serialised.
   */
  graphData: string;
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
 * `./diagrams.ts`: the Worker requires exactly that type on a mutation, and setting it uniformly
 * keeps a caller from having to remember which verbs need it.
 *
 * @param path Same-origin API path.
 * @param init Additional request options.
 * @returns The decoded response envelope.
 * @throws {Error} When the status is unsuccessful, carrying the server's `detail`, or when a
 *   successful response's body is absent or is not a JSON object.
 */
async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers }
  });

  const body = await jsonObject(response);
  if (!response.ok) {
    throw requestError(body);
  }

  if (body === null) {
    throw new Error(UNEXPECTED_RESPONSE);
  }
  return body;
}

/**
 * Reads whether a diagram the caller owns currently has an active share link.
 *
 * @param diagramId Diagram id.
 * @returns The diagram's current share status, never carrying a link.
 * @throws {Error} When the diagram does not exist or is not the caller's — the server reports both
 *   identically, so this client cannot distinguish them either.
 */
export async function getShareStatus(diagramId: string): Promise<ShareStatus> {
  const body = await request(`/api/diagrams/${encodeURIComponent(diagramId)}/share`);

  if (typeof body.active !== 'boolean') {
    throw new Error(UNEXPECTED_RESPONSE);
  }
  return { active: body.active, createdAt: (body.createdAt as string | null) ?? null };
}

/**
 * Creates a read-only share link for a diagram, revoking any link already active for it.
 *
 * @param diagramId Diagram id.
 * @returns The newly minted link. Its `url` is shown to the owner once and is then unrecoverable.
 * @throws {Error} When the request fails, including when the diagram is not the caller's, or when
 *   the response did not carry a usable link.
 */
export async function createShare(diagramId: string): Promise<CreatedShare> {
  const body = await request(`/api/diagrams/${encodeURIComponent(diagramId)}/share`, {
    method: 'POST'
  });

  if (typeof body.token !== 'string' || typeof body.url !== 'string') {
    throw new Error(UNEXPECTED_RESPONSE);
  }
  return {
    createdAt: (body.createdAt as string | undefined) ?? '',
    token: body.token,
    url: body.url
  };
}

/**
 * Revokes a diagram's active share link.
 *
 * Does not go through {@link request}: the endpoint answers `204` with no body, which
 * `response.json()` would reject.
 *
 * @param diagramId Diagram id.
 * @returns A promise fulfilled once the link no longer resolves.
 * @throws {Error} When the request fails, including when the diagram is not the caller's or has no
 *   active link.
 */
export async function revokeShare(diagramId: string): Promise<void> {
  const response = await fetch(`/api/diagrams/${encodeURIComponent(diagramId)}/share`, {
    headers: { 'Content-Type': 'application/json' },
    method: 'DELETE'
  });

  if (!response.ok) {
    throw requestError(await jsonObject(response));
  }
}

/**
 * Resolves a share token to the diagram's public, read-only fields.
 *
 * Anonymous: this is the one call in the client that needs no Access identity, because the token is
 * the whole of the authorization.
 *
 * @param token Share token taken from the `/s/:token` path.
 * @returns The shared diagram's public fields.
 * @throws {Error} When the token is malformed, unknown or revoked, or the diagram has since been
 *   deleted — all reported identically by the server, so they are indistinguishable here too.
 */
export async function getSharedDiagram(token: string): Promise<SharedDiagram> {
  const body = await request(`/api/shares/${encodeURIComponent(token)}`);

  if (!('diagram' in body)) {
    throw new Error(UNEXPECTED_RESPONSE);
  }
  return body.diagram as SharedDiagram;
}
