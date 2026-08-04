import {
  contentTooLarge,
  unprocessableContent,
  unsupportedMediaType,
} from "@adrianhall/cloudflare-toolkit/errors";

/**
 * Coarse, cheap-to-check outer bound on one dictation utterance's raw audio upload
 * (docs/06-AGENTIC-CHAT.md Phase 5, US-4). Generous relative to what an interactive
 * record-then-transcribe flow actually produces -- Spike E measured a ~12-second
 * `audio/webm;codecs=opus` utterance well under 200 KB
 * (`spikes/05-workers-ai-speech-to-text/REPORT.md`) -- while still rejecting a wildly oversized
 * payload before it is ever base64-encoded and sent to Workers AI.
 * `src/worker/middleware/transcribe-body-limit.ts` enforces this same number as a
 * `Content-Length`/streamed-byte precheck before the route handler runs at all, mirroring
 * `demos/ai-chat`'s `chatRequestBodyLimit` "coarse outer bound" framing;
 * {@link validateAudioBytes} re-checks it here as the inner, always-reached fallback for a
 * request with no `Content-Length` header at all.
 */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/**
 * Validate the request's declared audio MIME type before any bytes are read.
 *
 * Per Spike E, a browser's `MediaRecorder` is posted through with no client-side re-encoding, so
 * the real Content-Type varies by browser (`audio/webm;codecs=opus` on Chromium,
 * `audio/ogg;codecs=opus` on Firefox) -- this only requires an `audio/*` type, not one specific
 * container, matching that finding.
 *
 * @param contentType The raw `Content-Type` header value, or `null` if absent.
 * @returns The normalized (lower-cased, parameter-stripped) MIME type.
 * @throws {ProblemDetailsError} `415` when the header is missing or not an `audio/*` type.
 */
export function validateContentType(contentType: string | null): string {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === undefined || !normalized.startsWith("audio/")) {
    throw unsupportedMediaType({
      detail:
        "Content-Type must be an audio MIME type, for example audio/webm.",
    });
  }
  return normalized;
}

/**
 * Validate the decoded request body before it is base64-encoded and sent to Workers AI.
 *
 * @param bytes The raw request body.
 * @returns The same bytes, unchanged.
 * @throws {ProblemDetailsError} `422` for an empty body, `413` for a body over
 * {@link MAX_AUDIO_BYTES} -- the same limit `transcribeRequestBodyLimit` already enforces as a
 * `Content-Length` precheck; this is the fallback path for a request that arrived with no such
 * header.
 */
export function validateAudioBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength === 0) {
    throw unprocessableContent({
      detail: "The request body must contain audio data.",
    });
  }
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    throw contentTooLarge({
      detail: `Audio must not exceed ${MAX_AUDIO_BYTES} bytes.`,
    });
  }
  return bytes;
}
