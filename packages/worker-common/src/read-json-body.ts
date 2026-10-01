import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';

/**
 * Parses a request body as JSON, converting a malformed payload into an RFC 9457 `400`.
 *
 * Bound the body size first with {@link jsonBodyLimit}, then parse:
 *
 * ```ts
 * router.post('/', async (context) => {
 *   const input = await readJsonBody(context.req.raw);
 *   return context.json({ todo: await service.create(input) }, 201);
 * });
 * ```
 *
 * The result is typed `unknown` because no schema has been applied yet. Pass it to a domain
 * validator before using it.
 *
 * @param request Incoming request whose body should be parsed.
 * @returns The parsed JSON value, which may be any JSON type rather than only an object.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is absent, empty, or not valid
 *   JSON.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw badRequest({ detail: 'Request body must contain valid JSON.' });
  }
}
