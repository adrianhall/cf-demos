/**
 * @file The browser's only route to diagram data. Every function here speaks to the Worker's
 *   same-origin JSON API. Nothing in the client reaches D1, KV or a Durable Object, and nothing
 *   decides who owns a diagram: the server answers that on every request, and a `404` from these
 *   functions is the whole of what the browser is told.
 */

/**
 * A diagram as the API returns it.
 */
export interface DiagramSummary {
  /**
   * Server-generated UUID.
   */
  id: string;
  /**
   * Verified Cloudflare Access identity that owns this diagram.
   */
  ownerEmail: string;
  /**
   * User-editable title.
   */
  title: string;
  /**
   * Optional free-text description.
   */
  description: string | null;
  /**
   * JSON-serialised React Flow state: `{ nodes, edges, viewport }`.
   */
  graphData: string;
  /**
   * ISO-8601 creation timestamp.
   */
  createdAt: string;
  /**
   * ISO-8601 timestamp of the most recent metadata or graph update.
   */
  updatedAt: string;
}

/**
 * Fields accepted when creating a diagram.
 */
export interface CreateDiagramRequest {
  /**
   * Title for the new diagram.
   */
  title?: string;
  /**
   * Description for the new diagram.
   */
  description?: string;
  /**
   * Slug of the blueprint to seed the graph from. The server resolves it; the client never sends
   * graph content at creation time.
   */
  blueprintId?: string;
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
 * Prefers the problem document's `detail`, because the Worker writes that string specifically to be
 * shown to a person. Falls back to a fixed message rather than rendering an arbitrary response
 * body, which on a failure could be anything at all.
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
 * `Content-Type: application/json` is set on every call, including the reads. The Worker requires
 * exactly that type on a mutation — it is not a CORS-safelisted value, so requiring it means a
 * cross-origin form submission cannot reach a mutating endpoint at all — and setting it uniformly
 * keeps a caller from having to remember which verbs need it.
 *
 * Credentials are the browser's own same-origin defaults. The Access session lives in a cookie this
 * code never reads.
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

  // A successful response with an unreadable body is an error, not a value to hand on. Casting it
  // to the expected type instead would give the caller `undefined`, which surfaces later as a
  // crash while rendering rather than as a request failure anybody can act on.
  if (body === null) {
    throw new Error(UNEXPECTED_RESPONSE);
  }
  return body;
}

/**
 * Sends a request and reads one documented field from its response envelope.
 *
 * Every endpoint wraps its payload in a named field — `diagram`, `diagrams`, `updatedAt`. Checking
 * that the field is actually present turns a well-formed but unexpected body into a reported error
 * here, at the call site, instead of an `undefined` that propagates into a component and fails
 * somewhere with no connection to the request that caused it.
 *
 * @param path Same-origin API path.
 * @param field Envelope field carrying the payload.
 * @param init Additional request options.
 * @returns The field's value.
 * @throws {Error} When the request fails, or when the response does not carry `field`.
 */
async function requestField<T>(path: string, field: string, init?: RequestInit): Promise<T> {
  const body = await request(path, init);

  if (!(field in body)) {
    throw new Error(UNEXPECTED_RESPONSE);
  }
  return body[field] as T;
}

/**
 * Lists the signed-in identity's own diagrams, most recently updated first.
 *
 * @returns Every diagram the caller owns, each carrying its full graph so a card can render a real
 *   thumbnail without a second request.
 * @throws {Error} When the request fails, including a `401` when the Access session has expired.
 */
export async function listDiagrams(): Promise<DiagramSummary[]> {
  return requestField<DiagramSummary[]>('/api/diagrams', 'diagrams');
}

/**
 * Reads one diagram by id.
 *
 * @param id Diagram id.
 * @returns The requested diagram.
 * @throws {Error} When the diagram does not exist or is not the caller's — the server reports both
 *   identically, so this client cannot distinguish them either.
 */
export async function getDiagram(id: string): Promise<DiagramSummary> {
  return requestField<DiagramSummary>(`/api/diagrams/${encodeURIComponent(id)}`, 'diagram');
}

/**
 * Creates a diagram, blank or seeded from a blueprint.
 *
 * @param input Title, description and/or the blueprint slug to seed from.
 * @returns The newly created diagram.
 * @throws {Error} When the request fails, including an unknown blueprint or an invalid title.
 */
export async function createDiagram(input: CreateDiagramRequest): Promise<DiagramSummary> {
  return requestField<DiagramSummary>('/api/diagrams', 'diagram', {
    body: JSON.stringify(input),
    method: 'POST'
  });
}

/**
 * Renames a diagram and/or changes its description.
 *
 * @param id Diagram id.
 * @param input Fields to change. `description: null` clears it; omitting it leaves it unchanged.
 * @returns The updated diagram.
 * @throws {Error} When the request fails or the diagram is not the caller's.
 */
export async function updateDiagram(
  id: string,
  input: { title?: string; description?: string | null }
): Promise<DiagramSummary> {
  return requestField<DiagramSummary>(`/api/diagrams/${encodeURIComponent(id)}`, 'diagram', {
    body: JSON.stringify(input),
    method: 'PATCH'
  });
}

/**
 * Replaces a diagram's complete graph.
 *
 * The whole graph every time: there is no partial-patch protocol, so a save is always a complete
 * statement of the canvas rather than a difference against whatever the server currently holds.
 *
 * @param id Diagram id.
 * @param graphData JSON-serialised `{ nodes, edges, viewport }`.
 * @returns The new `updatedAt` timestamp.
 * @throws {Error} When the request fails, the graph is malformed, or the diagram is not the
 *   caller's.
 */
export async function saveDiagramGraph(id: string, graphData: string): Promise<string> {
  return requestField<string>(`/api/diagrams/${encodeURIComponent(id)}/graph`, 'updatedAt', {
    body: JSON.stringify({ graphData }),
    method: 'PUT'
  });
}

/**
 * Duplicates a diagram.
 *
 * One server-side request rather than the browser's own read-create-save sequence. That sequence
 * leaves an empty diagram behind if its middle step fails, and it only works at all because the
 * list endpoint happens to include each graph — a coupling a copy operation should not have.
 *
 * @param id Id of the diagram to copy.
 * @returns The newly created copy.
 * @throws {Error} When the request fails or the source diagram is not the caller's.
 */
export async function duplicateDiagram(id: string): Promise<DiagramSummary> {
  return requestField<DiagramSummary>(
    `/api/diagrams/${encodeURIComponent(id)}/duplicate`,
    'diagram',
    { method: 'POST' }
  );
}

/**
 * Builds the same-origin WebSocket URL for a diagram's live session.
 *
 * The scheme is derived from the page's own rather than written as a literal, so the socket uses
 * `wss:` exactly when the page was served over HTTPS. No credential appears in this URL: a
 * browser's `WebSocket` constructor cannot set request headers, so an API that expected a bearer
 * token here would have to put it in the query string, where it would land in every proxy log. The
 * Access session cookie travels on the upgrade request automatically, which is why the endpoint is
 * authenticated by exactly the same middleware as every other `/api/` route.
 *
 * @param id Diagram id.
 * @returns The `ws:` or `wss:` URL of that diagram's live endpoint, matching the page's scheme.
 */
export function diagramLiveUrl(id: string): string {
  const url = new URL(`/api/diagrams/${encodeURIComponent(id)}/live`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * Deletes a diagram.
 *
 * Does not go through {@link request}: the endpoint answers `204` with no body, which
 * `response.json()` would reject.
 *
 * @param id Diagram id.
 * @returns A promise fulfilled once the server has deleted the diagram.
 * @throws {Error} When the request fails or the diagram is not the caller's.
 */
export async function deleteDiagram(id: string): Promise<void> {
  const response = await fetch(`/api/diagrams/${encodeURIComponent(id)}`, {
    headers: { 'Content-Type': 'application/json' },
    method: 'DELETE'
  });

  if (!response.ok) {
    throw requestError(await jsonObject(response));
  }
}
