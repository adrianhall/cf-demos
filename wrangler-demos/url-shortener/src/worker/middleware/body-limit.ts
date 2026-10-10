import { badRequest } from "@adrianhall/cloudflare-toolkit/errors";
import { bodyLimit } from "hono/body-limit";

/** Maximum accepted JSON request body size for `/api/links` write routes. */
const MAX_REQUEST_BODY_BYTES = 8_192;

/**
 * Reject request bodies over {@link MAX_REQUEST_BODY_BYTES} with an RFC 9457 `400` before
 * a handler attempts to parse JSON. Checks the `Content-Length` header first and falls
 * back to counting streamed bytes, so a chunked request without `Content-Length` cannot
 * bypass the limit.
 */
export const requestBodyLimit = bodyLimit({
  maxSize: MAX_REQUEST_BODY_BYTES,
  onError: () => {
    throw badRequest({ detail: "Request body exceeds the 8 KB limit." });
  },
});
