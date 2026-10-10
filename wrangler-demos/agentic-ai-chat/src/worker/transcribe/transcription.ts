import {
  ProblemDetailsError,
  problemDetails,
} from "@adrianhall/cloudflare-toolkit/problem-details";

/**
 * The transcription model this demo calls, per Spike E's live comparison
 * (`spikes/05-workers-ai-speech-to-text/REPORT.md`). Deliberately not `@cf/deepgram/nova-3`:
 * that model's documented `env.AI` binding shape is live-rejected by the platform
 * (`5006: required properties at '/audio' are 'body,contentType'`) across every call path the
 * spike tried, including `workers-ai-provider`'s own shipped implementation -- only its REST
 * endpoint's raw-binary upload works, which the `env.AI` binding cannot reach.
 */
const TRANSCRIPTION_MODEL_ID = "@cf/openai/whisper-large-v3-turbo";

/**
 * The subset of `@cf/openai/whisper-large-v3-turbo`'s raw binding response this demo reads.
 * The full shape also carries `transcription_info`, `word_count`, `segments`, and `vtt`
 * (Spike E, REPORT.md §5) -- unused by `POST /api/transcribe`'s `{ text }` response today, but
 * available on `env.AI.run()`'s own result for a later phase wanting word-level timestamps
 * (`experimental_transcribe()` drops them entirely, which is why this module calls the binding
 * directly rather than going through it).
 */
interface WhisperTranscriptionResult {
  text?: unknown;
}

/**
 * Base64-encode audio bytes for `env.AI.run()`'s `{ audio: base64String }` input shape (Spike E
 * confirmed this is the shape the binding accepts, not a raw byte array). Chunks the conversion
 * so `String.fromCharCode(...bytes)` never spreads a multi-hundred-KB array onto the call stack
 * in one call -- the same defensive pattern `workers-ai-provider`'s own
 * `uint8ArrayToBase64()` uses internally (confirmed by Spike E reading its shipped
 * `dist/index.mjs`), and the same chunk size the spike's own probe used.
 *
 * @param bytes Raw audio bytes.
 * @returns The base64-encoded string.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8_192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

/**
 * Transcribe one dictation utterance via `env.AI.run()`, routed through AI Gateway.
 *
 * Calls the binding directly rather than the `ai` SDK's `experimental_transcribe()`: Spike E
 * found the installed `ai` version has no `mediaType` parameter at all (media type is derived by
 * magic-byte sniffing instead) and that its normalized `TranscriptionResult` drops Whisper's raw
 * per-word timestamps -- neither loss is acceptable for a call site this thin to introduce for no
 * benefit.
 *
 * @param ai The `AI` binding (or a test fake implementing `run()`).
 * @param gatewayId The AI Gateway id this call is routed through (`env.AI_GATEWAY_ID`) -- the
 * same gateway every chat turn already uses, so this call appears in the same gateway's request
 * log and is subject to the same rate/spend limits.
 * @param bytes Raw audio bytes, already validated by `src/worker/transcribe/validation.ts`.
 * @returns The transcribed text.
 * @throws {ProblemDetailsError} `502` when Workers AI rejects the call, the call itself throws,
 * or the response does not carry a `text` string.
 */
export async function transcribeAudio(
  ai: Pick<Ai, "run">,
  gatewayId: string,
  bytes: Uint8Array,
): Promise<string> {
  let result: unknown;
  try {
    result = await ai.run(
      TRANSCRIPTION_MODEL_ID,
      { audio: uint8ArrayToBase64(bytes) },
      { gateway: { id: gatewayId } },
    );
  } catch (error) {
    throw mapTranscriptionError(error);
  }

  const text = (result as WhisperTranscriptionResult | undefined)?.text;
  if (typeof text !== "string") {
    throw problemDetails({
      status: 502,
      title: "Transcription failed",
      detail: "Workers AI returned an unexpected transcription response shape.",
    });
  }
  return text;
}

/**
 * Map a Workers AI transcription failure onto an RFC 9457 `502`, never a raw stack trace.
 *
 * @param error The value caught from {@link transcribeAudio}'s `ai.run()` call.
 * @returns A `502` {@link ProblemDetailsError}.
 */
function mapTranscriptionError(error: unknown): ProblemDetailsError {
  if (error instanceof ProblemDetailsError) {
    return error;
  }
  return problemDetails({
    status: 502,
    title: "Transcription failed",
    detail: "Workers AI could not transcribe the submitted audio. Try again.",
  });
}
