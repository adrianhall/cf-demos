import { badRequest } from "@adrianhall/cloudflare-toolkit/errors";

/**
 * Parse a request body as JSON, converting a malformed payload into an RFC 9457 `400`.
 *
 * @param request Incoming request. Callers are expected to have already bounded the body
 * size (see `middleware/body-limit.ts`)  before this reads and parses it.
 * @returns Parsed JSON value.
 * @throws {ProblemDetailsError} When the body is not valid JSON.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw badRequest({ detail: "Request body must contain valid JSON." });
  }
}
