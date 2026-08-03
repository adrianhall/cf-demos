/**
 * @file Spike E — Workers AI speech-to-text input contract, browser-capture format
 * compatibility, and realistic latency (docs/06-AGENTIC-CHAT.md, Phase 0, Spike E).
 *
 * This is disposable spike code (docs/06-AGENTIC-CHAT.md, Section 8) — it answers one question
 * against the real account and is exempt from the demo contract in AGENTS.md. See README.md for
 * the exact aim and REPORT.md for what running it actually showed.
 *
 * `POST /transcribe?mode=<mode>` accepts a raw audio body (whatever bytes a browser's
 * `MediaRecorder` — or, for comparison, a client-side-converted file — would produce) and runs it
 * through one of six call shapes, timing only the model call itself (never per-fixture HTTP
 * overhead, which `scripts/probe.mjs` measures separately as `wallMs`):
 *
 * - `binding-base64` — `env.AI.run()` directly, `@cf/openai/whisper-large-v3-turbo`, base64 audio.
 *   This is the shape the real demo's `POST /api/transcribe` (US-4, Phase 5) is expected to use.
 * - `binding-array` — `env.AI.run()` directly, the older `@cf/openai/whisper` model, a plain
 *   array of byte values (Cloudflare's own documented shape for that model). Included only to
 *   confirm the turbo model's simpler base64 contract, not the array one, is what this demo needs.
 * - `experimental-transcribe` — the `ai` SDK's `experimental_transcribe()` with
 *   `workers-ai-provider`'s `transcription()` model factory, `@cf/openai/whisper-large-v3-turbo`.
 * - `nova3` / `nova3-raw-bytes` / `nova3-experimental-transcribe` — three variations on calling
 *   `@cf/deepgram/nova-3` (a documented comparison point only — Section 6's Alternatives-style
 *   reasoning for why turbo was chosen for this demo — Deepgram's own model is a
 *   real-time-streaming-first design, per "Real-time supported languages",
 *   developers.cloudflare.com/workers-ai/models/nova-3/, a worse fit than Whisper for this
 *   demo's one-shot "record, then transcribe" flow). All three exist only because the first
 *   (`workers-ai-provider`'s own documented shape) turned out to be live-rejected by the
 *   platform — see REPORT.md §3.
 */
import { experimental_transcribe } from "ai";
import { createWorkersAI } from "workers-ai-provider";

interface Env {
  AI: Ai;
}

/** The call shapes this spike compares. See the file-level JSDoc for what each proves. */
type Mode =
  | "binding-base64"
  | "binding-array"
  | "experimental-transcribe"
  | "nova3"
  | "nova3-raw-bytes"
  | "nova3-experimental-transcribe";

const MODES: readonly Mode[] = [
  "binding-base64",
  "binding-array",
  "experimental-transcribe",
  "nova3",
  "nova3-raw-bytes",
  "nova3-experimental-transcribe",
];

/**
 * Base64-encodes a `Uint8Array` without spreading the whole array onto the call stack
 * (`String.fromCharCode(...bytes)` on a multi-hundred-KB array risks
 * `RangeError: Maximum call stack size exceeded` in some engines) — chunking is the same
 * defensive pattern `workers-ai-provider`'s own `uint8ArrayToBase64()` uses internally
 * (confirmed by reading its shipped `dist/index.mjs`).
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Runs one audio fixture through one of the four call shapes and times only the model call
 * itself (`elapsedMs`), never request parsing — `scripts/probe.mjs` separately measures the
 * full round-trip (`wallMs`) so cold-start/network overhead is visible but not conflated with
 * model latency.
 */
async function runTranscription(
  mode: Mode,
  bytes: Uint8Array,
  contentType: string,
  env: Env,
): Promise<unknown> {
  switch (mode) {
    case "binding-base64":
      return env.AI.run(
        "@cf/openai/whisper-large-v3-turbo",
        { audio: uint8ArrayToBase64(bytes) },
        { gateway: { id: "default" } },
      );

    case "binding-array":
      return env.AI.run(
        "@cf/openai/whisper",
        { audio: Array.from(bytes) },
        { gateway: { id: "default" } },
      );

    case "experimental-transcribe": {
      // `ai@7.0.48`'s `transcribe()` has **no `mediaType` parameter at all** — a real, load-
      // bearing correction to Cloudflare's own `workers-ai-provider` changelog example
      // (developers.cloudflare.com/changelog/post/2026-02-13-glm-4.7-flash-workers-ai/), which
      // shows `experimental_transcribe({ ..., mediaType: "audio/wav" })`. This spike's own first
      // draft passed `mediaType` here and got a clean `tsc` type error (confirmed by reading
      // `node_modules/ai/dist/index.d.ts`'s `transcribe()` signature) rather than a silently
      // ignored option — see REPORT.md §2 for the full finding, including how the SDK derives
      // the media type instead (magic-byte sniffing over the raw bytes, not the caller's
      // Content-Type header at all).
      const workersai = createWorkersAI({ binding: env.AI, gateway: { id: "default" } });
      return experimental_transcribe({
        model: workersai.transcription("@cf/openai/whisper-large-v3-turbo"),
        audio: bytes,
      });
    }

    case "nova3":
      // `workers-ai-provider`'s own shipped `runNova3()` (dist/index.mjs) passes exactly this
      // shape — `{ audio: { body: base64String, contentType } }` — for the `env.AI` binding
      // path. REPORT.md §3 records that this shape is live-rejected by the platform with a
      // schema-validation error, contradicting the provider's own implementation — see the
      // `nova3-raw-bytes` case below for what the REST endpoint (a genuinely different upload
      // path) actually requires instead.
      return env.AI.run(
        "@cf/deepgram/nova-3",
        { audio: { body: uint8ArrayToBase64(bytes) as unknown as object, contentType } },
        { gateway: { id: "default" } },
      );

    case "nova3-raw-bytes":
      // Passing the decoded `Uint8Array` directly as `body` (never base64-encoded) — the
      // binding is an in-isolate RPC call, not a JSON-over-HTTP request, so it can carry a real
      // binary value where the REST endpoint could not. See REPORT.md §3 for whether this is
      // the shape that actually works.
      return env.AI.run(
        "@cf/deepgram/nova-3",
        { audio: { body: bytes as unknown as object, contentType } },
        { gateway: { id: "default" } },
      );

    case "nova3-experimental-transcribe": {
      // Confirms `nova3`'s live-rejected shape (above) is exactly what `workers-ai-provider`'s
      // own shipped `experimental_transcribe()` integration sends for the `env.AI` binding path
      // — not an artifact of this spike's own hand-rolled call — by driving the same model
      // through the SDK entry point the real demo would actually call.
      const workersai = createWorkersAI({ binding: env.AI, gateway: { id: "default" } });
      return experimental_transcribe({
        model: workersai.transcription("@cf/deepgram/nova-3"),
        audio: bytes,
      });
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/transcribe") {
      return new Response(
        `POST /transcribe?mode=<${MODES.join("|")}>, body = raw audio bytes, Content-Type = the audio's real MIME type.`,
        { status: 404 },
      );
    }

    const modeParam = url.searchParams.get("mode") ?? "binding-base64";
    if (!MODES.includes(modeParam as Mode)) {
      return Response.json({ error: `Unknown mode '${modeParam}'. Use one of: ${MODES.join(", ")}` }, { status: 400 });
    }
    const mode = modeParam as Mode;

    const contentType = request.headers.get("content-type") ?? "application/octet-stream";
    const bytes = new Uint8Array(await request.arrayBuffer());

    const start = Date.now();
    try {
      const result = await runTranscription(mode, bytes, contentType, env);
      return Response.json({
        mode,
        contentType,
        byteLength: bytes.byteLength,
        elapsedMs: Date.now() - start,
        ok: true,
        result,
      });
    } catch (error) {
      // Logged (Workers Logs / `wrangler tail`) and surfaced verbatim in the response — this
      // spike needs the raw error message to tell "wrong input shape" apart from "model
      // rejected this audio format", never a generic 500 (Section 8's "not a demo" exemption
      // from AGENTS.md's error-hiding conventions applies here).
      console.error(`[spike] transcription error (mode=${mode})`, error);
      return Response.json(
        {
          mode,
          contentType,
          byteLength: bytes.byteLength,
          elapsedMs: Date.now() - start,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 502 },
      );
    }
  },
};
