/**
 * RFC 9457 response fields the UI is willing to display.
 *
 * Only these two are read. The Worker never emits a stack trace in production (see
 * `src/worker/index.ts`), and reading nothing else keeps the browser from rendering anything
 * unexpected even if it did.
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
 * @param response Non-successful response from the same-origin API.
 * @returns An error carrying the problem detail or title, or a generic message when the body is
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
 * Call the same-origin API and parse a JSON response.
 *
 * Mutations send `Content-Type: application/json`, which a cross-origin form post cannot set
 * without a preflight — so the browser's own CORS rules, rather than a token the application would
 * have to manage, are what stop a third-party page from driving these endpoints.
 *
 * @typeParam T Shape the caller expects the response body to have.
 * @param path Same-origin API path, such as `/api/faqs`.
 * @param init Optional method and body. A supplied `body` is serialized as JSON.
 * @returns The parsed response body.
 * @throws {Error} When the response status is not successful, carrying the RFC 9457 detail where
 *   the server supplied one.
 */
export async function requestJson<T>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    ...(init?.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) })
  });
  if (!response.ok) {
    throw await requestError(response);
  }
  return (await response.json()) as T;
}

/**
 * Call the same-origin API for an endpoint that answers `204 No Content`.
 *
 * Separate from {@link requestJson} because parsing an empty body as JSON throws, and a caller
 * should not have to remember which endpoints return a body.
 *
 * @param path Same-origin API path.
 * @param method HTTP method to use.
 * @returns A promise fulfilled once the request succeeds.
 * @throws {Error} When the response status is not successful.
 */
export async function requestEmpty(path: string, method: string): Promise<void> {
  const response = await fetch(path, { method });
  if (!response.ok) {
    throw await requestError(response);
  }
}
