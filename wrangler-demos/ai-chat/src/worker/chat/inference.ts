import {
  ProblemDetailsError,
  problemDetails,
} from "@adrianhall/cloudflare-toolkit/problem-details";
import type { ChatMessage, UsageInfo } from "../../chat-protocol";
import type { ModelDescriptor } from "../../models";
import { decodeSseStream } from "../../sse";
import {
  openInferenceStream as dispatchOpenInferenceStream,
  readInferenceChunk,
} from "./adapters";
import type { AdapterParams } from "./adapters/types";
import { createThinkTagSplitter } from "./reasoning";
import { SYSTEM_PROMPT } from "./validation";

/**
 * One normalized inference event, ready for `src/worker/chat/stream.ts` to encode as a
 * `ChatStreamFrame`. Distinct from an adapter's raw `NormalizedChunk` only in that, for a model
 * using the `inline-think-tags` reasoning mechanism, `answerDelta`/`thinkingDelta` here have
 * already been separated by `src/worker/chat/reasoning.ts` — an adapter's own chunk never has.
 */
export interface InferenceEvent {
  answerDelta?: string;
  thinkingDelta?: string;
  usage?: UsageInfo;
  finishReason?: string;
}

/**
 * Open the upstream Workers AI stream for one turn, prepending the server-owned system prompt.
 *
 * This function's own failure — Workers AI rejecting the request, or the call itself throwing —
 * happens **before any byte of the outgoing response has been written**, so its caller
 * (`src/worker/routes/chat.ts`) can and must let it propagate as an ordinary RFC 9457 JSON
 * response rather than an in-band `error` frame (see docs/05-AI-CHAT.md, "Streaming Protocol").
 * Keeping this `await` outside of {@link readInferenceEvents}'s generator body — instead of
 * lazily inside a generator only executed once iteration begins — is what makes that timing
 * guarantee hold.
 *
 * @param ai The `AI` binding.
 * @param descriptor The resolved, validated model descriptor.
 * @param messages The validated conversation (never including a client-supplied system message).
 * @param params Temperature and output-token-limit, already clamped to `descriptor`'s bounds.
 * @param signal Optional abort signal, propagated to the adapter's `env.AI.run()` call so an
 * aborted request never begins generating.
 * @returns The upstream raw SSE byte stream.
 * @throws {ProblemDetailsError} A `502` describing the upstream failure (see
 * {@link mapUpstreamError}).
 */
export async function openInferenceStream(
  ai: Ai,
  descriptor: ModelDescriptor,
  messages: readonly ChatMessage[],
  params: AdapterParams,
  signal?: AbortSignal,
): Promise<ReadableStream> {
  const fullMessages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    ...messages,
  ];
  try {
    return await dispatchOpenInferenceStream(
      ai,
      descriptor,
      fullMessages,
      params,
      signal,
    );
  } catch (error) {
    throw mapUpstreamError(error);
  }
}

/**
 * Read an already-open upstream stream into a sequence of normalized {@link InferenceEvent}s.
 *
 * Decodes the raw SSE bytes with the shared `src/sse.ts` decoder, hands each parsed frame to
 * `descriptor`'s adapter, and — only for a model declaring `reasoning: "inline-think-tags"` —
 * pipes the adapter's combined answer text through a fresh `src/worker/chat/reasoning.ts`
 * splitter before yielding. A malformed individual frame (fails `JSON.parse`) is skipped rather
 * than aborting the whole turn.
 *
 * Any failure here occurs **after** the upstream stream already opened, so
 * `src/worker/chat/stream.ts` converts a thrown error from this generator into an in-band
 * `error` frame and closes the stream — never an HTTP-level status change.
 *
 * @param descriptor The resolved, validated model descriptor.
 * @param upstreamStream The stream returned by {@link openInferenceStream}.
 * @yields Normalized events, in the order the model produced them, plus one final flush event
 * for any reasoning text an unclosed `<think>` block left held back.
 * @throws {ProblemDetailsError} A `502` describing a failure the SSE reader itself encountered
 * (for example the upstream connection dropping mid-stream).
 */
export async function* readInferenceEvents(
  descriptor: ModelDescriptor,
  upstreamStream: ReadableStream,
): AsyncGenerator<InferenceEvent, void, unknown> {
  const splitter =
    descriptor.reasoning === "inline-think-tags"
      ? createThinkTagSplitter()
      : undefined;

  try {
    for await (const payload of decodeSseStream(upstreamStream)) {
      if (payload === "[DONE]") {
        break;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      const chunk = readInferenceChunk(descriptor, parsed);

      if (splitter && chunk.answerDelta) {
        const split = splitter.push(chunk.answerDelta);
        const event: InferenceEvent = {};
        if (split.answer) event.answerDelta = split.answer;
        if (split.thinking) event.thinkingDelta = split.thinking;
        if (chunk.usage) event.usage = chunk.usage;
        if (chunk.finishReason) event.finishReason = chunk.finishReason;
        if (Object.keys(event).length > 0) {
          yield event;
        }
        continue;
      }

      if (
        chunk.answerDelta ||
        chunk.thinkingDelta ||
        chunk.usage ||
        chunk.finishReason
      ) {
        yield chunk;
      }
    }

    if (splitter) {
      const flushed = splitter.flush();
      if (flushed.thinking) {
        yield { thinkingDelta: flushed.thinking };
      }
      if (flushed.answer) {
        yield { answerDelta: flushed.answer };
      }
    }
  } catch (error) {
    throw mapUpstreamError(error);
  }
}

/**
 * Map a Workers AI failure onto an RFC 9457 problem with a distinct, demo-appropriate cause.
 * Workers AI errors are plain `Error`s carrying a human-readable message (`InferenceUpstreamError`
 * / `AiInternalError` in the generated types are unstructured marker interfaces, adding no
 * further fields to inspect), so this matches on message content — best-effort, not a guarantee
 * every upstream failure lands in the "right" bucket, but every bucket is at least a `502` naming
 * the request as an upstream failure rather than surfacing a raw stack trace.
 *
 * @param error The value caught from an adapter's `run()` call or the SSE reader.
 * @returns A `502` {@link ProblemDetailsError}, with `detail` distinguishing rate limiting,
 * context-window exhaustion, an unavailable model, and rejected input from a generic failure.
 */
function mapUpstreamError(error: unknown): ProblemDetailsError {
  if (error instanceof ProblemDetailsError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  if (/rate.?limit/iu.test(message)) {
    return problemDetails({
      status: 502,
      title: "Upstream rate limited",
      detail: "Workers AI rate-limited this request. Try again shortly.",
    });
  }
  if (/context|too many tokens|maximum.*(length|tokens)/iu.test(message)) {
    return problemDetails({
      status: 502,
      title: "Context window exceeded",
      detail: "The conversation exceeds the selected model's context window.",
    });
  }
  if (
    /not found|no such model|unknown model|unsupported model/iu.test(message)
  ) {
    return problemDetails({
      status: 502,
      title: "Model unavailable",
      detail: "The selected model is currently unavailable on Workers AI.",
    });
  }
  if (/bad input|invalid|must be|validation/iu.test(message)) {
    return problemDetails({
      status: 502,
      title: "Upstream rejected input",
      detail:
        "Workers AI rejected the request parameters for the selected model.",
    });
  }
  return problemDetails({
    status: 502,
    title: "Inference failed",
    detail: "Workers AI inference failed for the selected model.",
  });
}
