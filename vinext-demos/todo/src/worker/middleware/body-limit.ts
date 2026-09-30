import { bodyLimit } from 'hono/body-limit';
import { badRequest } from '@adrianhall/cloudflare-toolkit/errors';

/**
 * Maximum accepted JSON request body size for task write routes. A task payload is a single short
 * title, so a few kilobytes is generous; the point is to have an explicit bound rather than to
 * accommodate any real request.
 */
const MAX_REQUEST_BODY_BYTES = 8_192;

/**
 * Reject request bodies over {@link MAX_REQUEST_BODY_BYTES} with an RFC 9457 `400` before a handler
 * attempts to parse JSON.
 *
 * Hono checks the `Content-Length` header first and falls back to counting streamed bytes, so a
 * chunked request that omits `Content-Length` cannot bypass the limit. Bounding the body before
 * parsing means an oversized payload is refused without the Worker buffering it.
 */
export const requestBodyLimit = bodyLimit({
  maxSize: MAX_REQUEST_BODY_BYTES,
  onError: () => {
    throw badRequest({ detail: 'Request body exceeds the 8 KB limit.' });
  }
});
