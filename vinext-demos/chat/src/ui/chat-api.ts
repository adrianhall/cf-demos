/**
 * @file Same-origin HTTP client for the channel API. This is the only module in the UI tier that
 *   knows the API's URLs and payload shapes, so components deal in channels rather than in `fetch`
 *   calls. It never sends an identity: the Worker derives the participant from the verified
 *   Cloudflare Access JWT (see `src/worker/routes/identity.ts`), so there is nothing for the client
 *   to pass and no way for it to act as somebody else.
 */

/**
 * A channel as returned by the same-origin channel API.
 */
export interface Channel {
  /**
   * Normalized channel name, also used as the Durable Object's name.
   */
  name: string;
  /**
   * Verified identity that created the channel.
   */
  createdBy: string;
  /**
   * ISO-8601 creation timestamp.
   */
  createdAt: string;
}

/**
 * RFC 9457 response fields the UI is willing to display.
 */
interface ProblemDetails {
  /**
   * User-safe explanation of a failed request.
   */
  detail?: string;
  /**
   * Standard status-text fallback.
   */
  title?: string;
}

/**
 * Convert an unsuccessful API response into a user-safe error.
 *
 * Only `detail` and `title` are read. The Worker never emits a stack trace in production (see
 * `src/worker/index.ts`), and this keeps the client from rendering anything else even if it did.
 *
 * @param response Non-successful HTTP response returned by the same-origin API.
 * @returns An error carrying the RFC 9457 detail/title, or a generic message when the body is
 *   absent or unparseable.
 */
async function requestError(response: Response): Promise<Error> {
  try {
    const problem = (await response.json()) as ProblemDetails;
    return new Error(problem.detail ?? problem.title ?? 'The request could not be completed.');
  } catch {
    return new Error('The request could not be completed.');
  }
}

/**
 * Execute a JSON API request and decode the response.
 *
 * @typeParam T Expected JSON response shape supplied by the caller.
 * @param path Same-origin API path to request.
 * @param init Optional fetch options, including the HTTP method and request body.
 * @returns The successful response body decoded as the caller's expected shape.
 * @throws {Error} When the API returns a non-success response — with an RFC 9457-derived message
 *   when one is available. Transport and JSON-decoding failures also reject.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers }
  });
  if (!response.ok) {
    throw await requestError(response);
  }
  return (await response.json()) as T;
}

/**
 * Fetch every channel in the shared workspace.
 *
 * There is no per-identity filter, here or in the Worker: this is a shared workspace, so every
 * authenticated participant sees the same directory.
 *
 * @returns Every channel, name-ordered as the API returned them.
 * @throws {Error} When authentication, transport, or API processing fails.
 */
export async function listChannels(): Promise<Channel[]> {
  return (await request<{ channels: Channel[] }>('/api/channels')).channels;
}

/**
 * Create a channel.
 *
 * The API-confirmed channel is returned rather than the submitted text, so a caller that joins the
 * new channel immediately joins the _normalized_ name the server actually stored.
 *
 * @param name Candidate channel name entered by the participant.
 * @returns The API-confirmed channel.
 * @throws {Error} When the name is invalid (`422`), already taken (`409`), or the request otherwise
 *   fails.
 */
export async function createChannel(name: string): Promise<Channel> {
  return (
    await request<{ channel: Channel }>('/api/channels', {
      body: JSON.stringify({ name }),
      method: 'POST'
    })
  ).channel;
}

/**
 * Remove a channel and everything said in it.
 *
 * `Content-Type` is deliberately omitted: this request carries no body, so announcing a JSON
 * payload that does not exist would be misleading. A `204` also has no body to parse, which is why
 * this does not go through {@link request}.
 *
 * @param name Name of the channel to remove.
 * @returns A promise fulfilled once the API confirms the removal.
 * @throws {Error} When the channel no longer exists (`404`) or the request otherwise fails.
 */
export async function removeChannel(name: string): Promise<void> {
  const response = await fetch(`/api/channels/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!response.ok) {
    throw await requestError(response);
  }
}

/**
 * Fetch the Worker's verified view of the current Cloudflare Access identity.
 *
 * This is how the UI notices an expired Access session: once the JWT is no longer valid, `/api/me`
 * answers `401` and this resolves to `null` rather than rejecting, because an unavailable identity
 * indicator must not prevent the workspace from rendering.
 *
 * @returns The verified identity's email address, or `null` when the session cannot be verified.
 */
export async function getIdentity(): Promise<string | null> {
  try {
    const response = await fetch('/api/me');
    if (!response.ok) {
      return null;
    }
    return ((await response.json()) as { email: string }).email;
  } catch {
    return null;
  }
}
