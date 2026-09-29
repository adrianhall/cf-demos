/**
 * Link record returned by the same-origin management API.
 */
export interface ShortLink {
  /**
   * Immutable identifier used in the public short URL.
   */
  code: string;
  /**
   * Redirect target.
   */
  destination: string;
  /**
   * ISO-8601 creation timestamp.
   */
  createdAt: string;
  /**
   * ISO-8601 timestamp for the latest update.
   */
  updatedAt: string;
}

/**
 * RFC 9457 fields that can safely be shown to the administrator.
 */
interface ProblemDetails {
  /**
   * User-safe explanation of the failure.
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
 * @param response Non-successful response from the same-origin API.
 * @returns An error with a safe RFC 9457 message or generic fallback.
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
 * Execute a JSON API request and decode its successful response.
 *
 * @typeParam T Expected JSON response shape.
 * @param path Same-origin path to request.
 * @param init Optional request settings.
 * @returns The decoded successful response body.
 * @throws {Error} When the request fails or the API returns an error response.
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
 * Fetch every managed link.
 *
 * @returns The current link collection.
 * @throws {Error} When the API cannot provide the collection.
 */
export async function listLinks(): Promise<ShortLink[]> {
  return (await request<{ links: ShortLink[] }>('/api/links')).links;
}

/**
 * Create a short link.
 *
 * @param destination Candidate redirect destination.
 * @returns The API-confirmed stored link.
 * @throws {Error} When validation, authorization, transport, or API processing fails.
 */
export async function createLink(destination: string): Promise<ShortLink> {
  return (
    await request<{ link: ShortLink }>('/api/links', {
      body: JSON.stringify({ destination }),
      method: 'POST'
    })
  ).link;
}

/**
 * Update one short link's destination.
 *
 * @param code Immutable short-link code.
 * @param destination Replacement redirect destination.
 * @returns The API-confirmed updated link.
 * @throws {Error} When validation, authorization, transport, or API processing fails.
 */
export async function updateLink(code: string, destination: string): Promise<ShortLink> {
  return (
    await request<{ link: ShortLink }>(`/api/links/${encodeURIComponent(code)}`, {
      body: JSON.stringify({ destination }),
      method: 'PUT'
    })
  ).link;
}

/**
 * Delete one short link.
 *
 * @param code Immutable short-link code.
 * @returns A promise fulfilled once the API confirms deletion.
 * @throws {Error} When authorization, transport, or API processing fails.
 */
export async function deleteLink(code: string): Promise<void> {
  const response = await fetch(`/api/links/${encodeURIComponent(code)}`, { method: 'DELETE' });
  if (!response.ok) {
    throw await requestError(response);
  }
}

/**
 * Check whether the current Cloudflare Access identity is the administrator.
 *
 * @returns The administrator email, or `null` when the identity is not authorized.
 */
export async function getAdministratorEmail(): Promise<string | null> {
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
