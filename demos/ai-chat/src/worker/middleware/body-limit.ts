import { contentTooLarge } from "@adrianhall/cloudflare-toolkit/errors";
import { bodyLimit } from "hono/body-limit";

/**
 * Maximum accepted JSON request body size for `POST /api/chat`. Generous relative to
 * `demos/url-shortener`'s 8 KB link-write limit because a multi-turn conversation accumulates:
 * `src/worker/chat/validation.ts`'s per-message and total-character caps are the primary cost
 * control, so this exists as a coarse, cheap-to-check outer bound that rejects a wildly oversized
 * payload before any JSON parsing is attempted.
 */
const MAX_REQUEST_BODY_BYTES = 65_536;

/**
 * Reject `/api/chat` request bodies over {@link MAX_REQUEST_BODY_BYTES} with an RFC 9457 `413`
 * before a handler attempts to parse JSON. Checks `Content-Length` first and falls back to
 * counting streamed bytes, so a chunked request without `Content-Length` cannot bypass the limit.
 */
export const chatRequestBodyLimit = bodyLimit({
  maxSize: MAX_REQUEST_BODY_BYTES,
  onError: () => {
    throw contentTooLarge({
      detail: `Request body exceeds the ${MAX_REQUEST_BODY_BYTES} byte limit.`,
    });
  },
});
