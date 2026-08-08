import { badRequest } from "@adrianhall/cloudflare-toolkit/errors";
import { bodyLimit } from "hono/body-limit";

/**
 * Maximum accepted JSON request body size for `/api/diagrams` write routes. Far larger than
 * `demos/url-shortener`'s 8 KB limit: a diagram's `graphData` carries every node's position and
 * label plus every edge, so a large, richly annotated diagram can legitimately run to tens of
 * kilobytes -- 512 KB comfortably covers that while still bounding worst-case request cost.
 */
const MAX_REQUEST_BODY_BYTES = 512 * 1_024;

/**
 * Reject request bodies over {@link MAX_REQUEST_BODY_BYTES} with an RFC 9457 `400` before a
 * handler attempts to parse JSON.
 */
export const requestBodyLimit = bodyLimit({
  maxSize: MAX_REQUEST_BODY_BYTES,
  onError: () => {
    throw badRequest({ detail: "Request body exceeds the 512 KB limit." });
  },
});
