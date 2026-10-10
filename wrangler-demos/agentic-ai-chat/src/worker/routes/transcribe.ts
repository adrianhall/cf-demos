import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { transcribeRequestBodyLimit } from "../middleware/transcribe-body-limit";
import { transcribeAudio } from "../transcribe/transcription";
import {
  validateAudioBytes,
  validateContentType,
} from "../transcribe/validation";

/**
 * Voice-to-prompt dictation (docs/06-AGENTIC-CHAT.md Phase 5, US-4), mounted at
 * `/api/transcribe`. Already covered by `src/access-policies.ts`'s blanket `^\/api` policy, so
 * no dedicated Access policy entry is needed.
 */
export const transcribeRouter = new Hono<AppBindings>();

/**
 * Transcribe one dictation utterance, posted as the browser's raw `MediaRecorder` output with no
 * client-side conversion (Spike E) -- validated by content type and size before any bytes are
 * sent to Workers AI, then transcribed via `env.AI.run()`, routed through this Worker's own AI
 * Gateway. The transcript populates the composer client-side; this route never touches D1 or a
 * chat's own conversation state, so it needs no ownership check beyond the blanket Access
 * requirement already applied to every `/api/*` route.
 */
transcribeRouter.post("/", transcribeRequestBodyLimit, async (context) => {
  const contentType = validateContentType(
    context.req.header("content-type") ?? null,
  );
  const bytes = validateAudioBytes(
    new Uint8Array(await context.req.arrayBuffer()),
  );
  const text = await transcribeAudio(
    context.env.AI,
    context.env.AI_GATEWAY_ID,
    bytes,
  );
  context.get("LOGGER").info("transcription_completed", {
    audioBytes: bytes.byteLength,
    contentType,
    transcriptCharacters: text.length,
  });
  return context.json({ text });
});
