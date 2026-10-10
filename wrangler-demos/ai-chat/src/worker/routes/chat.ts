import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { openInferenceStream } from "../chat/inference";
import { buildInferenceLogFields } from "../chat/log-fields";
import { buildChatStreamResponse } from "../chat/stream";
import { validateChatRequest } from "../chat/validation";
import { readJsonBody } from "../lib/read-json-body";
import { chatRequestBodyLimit } from "../middleware/body-limit";

/**
 * The streaming inference API, mounted at `/api/chat` by `../index.ts`. Every route here is
 * behind Cloudflare Access in production (see `middleware/access.ts`) — inference is billable
 * compute, so this demo has no public route (see docs/05-AI-CHAT.md, "Access Model").
 */
export const chatRouter = new Hono<AppBindings>();

chatRouter.use(chatRequestBodyLimit);

/**
 * Run one turn of the conversation and stream the answer back over Server-Sent Events.
 *
 * Request validation and opening the upstream Workers AI stream both happen **before** this
 * handler returns anything, so a rejection at either step (an unknown model, a malformed
 * conversation, or Workers AI itself rejecting the input) surfaces as an ordinary RFC 9457 JSON
 * response — never as a partially-started event stream. Only a failure *after* the stream opens
 * becomes an in-band `error` frame (`src/worker/chat/stream.ts`).
 *
 * Structured logs are informational only and are built exclusively through
 * `buildInferenceLogFields()`, which cannot structurally carry prompt or completion text — see
 * that function's docs for the guarantee this relies on.
 */
chatRouter.post("/", async (context) => {
  const logger = context.get("LOGGER");
  const validated = validateChatRequest(await readJsonBody(context.req.raw));
  const { descriptor, messages, temperature, maxTokens } = validated;

  const requestId = crypto.randomUUID();
  const messageCount = messages.length;
  const totalCharacters = messages.reduce(
    (sum, message) => sum + message.content.length,
    0,
  );
  const logFieldsBase = {
    model: descriptor.id,
    requestId,
    messageCount,
    totalCharacters,
  };

  logger.info("ai_prompt_submitted", buildInferenceLogFields(logFieldsBase));

  const abortController = new AbortController();
  const upstreamStream = await openInferenceStream(
    context.env.AI,
    descriptor,
    messages,
    { temperature, maxTokens },
    abortController.signal,
  );

  return buildChatStreamResponse(
    descriptor.id,
    requestId,
    descriptor,
    upstreamStream,
    {
      abortController,
      callbacks: {
        onFirstToken: (ttftMs) => {
          logger.info(
            "ai_first_token",
            buildInferenceLogFields({ ...logFieldsBase, ttftMs }),
          );
        },
        onDone: ({ ttftMs, totalMs, usage, finishReason }) => {
          logger.info(
            "ai_stream_completed",
            buildInferenceLogFields({
              ...logFieldsBase,
              ttftMs,
              totalMs,
              usage,
              finishReason,
            }),
          );
        },
        onAborted: ({ ttftMs, totalMs }) => {
          logger.info(
            "ai_stream_aborted",
            buildInferenceLogFields({ ...logFieldsBase, ttftMs, totalMs }),
          );
        },
        onFailed: ({ ttftMs, totalMs, status, detail }) => {
          logger.info(
            "ai_inference_failed",
            buildInferenceLogFields({
              ...logFieldsBase,
              ttftMs,
              totalMs,
              status,
              detail,
            }),
          );
        },
      },
    },
  );
});
