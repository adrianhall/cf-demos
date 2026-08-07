import { contentTooLarge } from "@adrianhall/cloudflare-toolkit/errors";
import { bodyLimit } from "hono/body-limit";

/**
 * Maximum accepted JSON request body size for `/api/diagrams` write routes.
 *
 * Sized generously relative to `/api/links`' 8 KB limit in `demos/url-shortener` because a
 * `replace_document` operation's payload embeds an entire `GraphDocument` — still far below a
 * pathological upload, but enough headroom for a diagram with dozens of nodes and edges.
 */
const MAX_REQUEST_BODY_BYTES = 131_072;

/**
 * Reject request bodies over {@link MAX_REQUEST_BODY_BYTES} with an RFC 9457 `413` before a
 * handler attempts to parse JSON. Checks `Content-Length` first and falls back to counting
 * streamed bytes, so a chunked request without `Content-Length` cannot bypass the limit.
 */
export const requestBodyLimit = bodyLimit({
  maxSize: MAX_REQUEST_BODY_BYTES,
  onError: () => {
    throw contentTooLarge({
      detail: `Request body exceeds the ${MAX_REQUEST_BODY_BYTES} byte limit.`,
    });
  },
});
