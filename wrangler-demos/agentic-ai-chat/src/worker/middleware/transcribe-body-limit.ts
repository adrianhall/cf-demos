import { contentTooLarge } from "@adrianhall/cloudflare-toolkit/errors";
import { bodyLimit } from "hono/body-limit";
import { MAX_AUDIO_BYTES } from "../transcribe/validation";

/**
 * Reject `POST /api/transcribe` request bodies over {@link MAX_AUDIO_BYTES} with an RFC 9457
 * `413` before the route handler reads any bytes. Checks `Content-Length` first and falls back
 * to counting streamed bytes, so a chunked request without `Content-Length` cannot bypass the
 * limit -- mirrors `demos/ai-chat`'s `chatRequestBodyLimit`, applied to a raw audio upload
 * instead of a JSON chat request.
 */
export const transcribeRequestBodyLimit = bodyLimit({
  maxSize: MAX_AUDIO_BYTES,
  onError: () => {
    throw contentTooLarge({
      detail: `Request body exceeds the ${MAX_AUDIO_BYTES} byte limit.`,
    });
  },
});
