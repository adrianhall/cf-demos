import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';

/**
 * Parse a request body as JSON, converting a malformed payload into an RFC 9457 `400`.
 *
 * Without this, a syntactically invalid body would surface as an unhandled `SyntaxError` and be
 * reported as a `500` — blaming the server for a client mistake.
 *
 * @param request Incoming request. Callers are expected to have already bounded the body size (see
 *   `../middleware/body-limit.ts`) before this reads and parses it.
 * @returns The parsed JSON value, still untrusted and not yet validated against any schema.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is absent or not valid JSON.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw badRequest({ detail: 'Request body must contain valid JSON.' });
  }
}
