import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';

/**
 * Default maximum request body size applied by {@link jsonBodyLimit}, in bytes.
 */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 8_192;

/**
 * Renders a byte count for an error message, using kilobytes when the value divides evenly.
 *
 * @param bytes Limit to describe.
 * @returns A short human-readable size such as `"8 KB"` or `"1500 bytes"`.
 */
function describeLimit(bytes: number): string {
  return bytes % 1024 === 0 ? `${bytes / 1024} KB` : `${bytes} bytes`;
}

/**
 * Creates middleware rejecting request bodies larger than a byte limit with an RFC 9457 `400`.
 *
 * Mount it on a router before any handler that parses a body:
 *
 * ```ts
 * todosRouter.use(jsonBodyLimit()); // 8 KB default
 * uploadsRouter.use(jsonBodyLimit(65_536)); // 64 KB
 * ```
 *
 * The `Content-Length` header is checked first, falling back to counting streamed bytes, so a
 * chunked request that omits `Content-Length` cannot bypass the limit. A request with no body is
 * always allowed.
 *
 * @param maxBytes Largest accepted body size in bytes. Defaults to
 *   {@link DEFAULT_MAX_REQUEST_BODY_BYTES}.
 * @returns Hono middleware enforcing the limit, mountable with `router.use(...)`.
 * @throws {ProblemDetailsError} `badRequest()` (400) at request time when the body exceeds
 *   `maxBytes`.
 */
export function jsonBodyLimit(
  maxBytes: number = DEFAULT_MAX_REQUEST_BODY_BYTES
): MiddlewareHandler {
  return bodyLimit({
    maxSize: maxBytes,
    onError: () => {
      throw badRequest({ detail: `Request body exceeds the ${describeLimit(maxBytes)} limit.` });
    }
  });
}
