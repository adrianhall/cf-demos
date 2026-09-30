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
export async function requestError(response: Response): Promise<Error> {
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
export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
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
 * Execute an API request that returns no body.
 *
 * Kept separate from {@link requestJson} rather than folded into it with an optional decode step,
 * because a `204` has no body to parse and calling `json()` on one throws. The distinction is in
 * the API's contract, so it is worth making it visible at the call site.
 *
 * @param path Same-origin API path to request.
 * @param init Optional fetch options, including the HTTP method.
 * @returns A promise fulfilled once the API confirms success.
 * @throws {Error} When the API returns a non-success response, or the request cannot be sent.
 */
export async function requestEmpty(path: string, init?: RequestInit): Promise<void> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw await requestError(response);
  }
}
