import { ProblemDetailsError } from "@adrianhall/cloudflare-toolkit/problem-details";
import type { ChatStreamFrame, UsageInfo } from "../../chat-protocol";
import type { ModelDescriptor } from "../../models";
import { readInferenceEvents } from "./inference";

/** Outcome reported to {@link ChatStreamCallbacks.onDone} when a turn completes normally. */
export interface ChatStreamDoneResult {
  /** Time from request start to the first `thinking`/`answer` delta, or `null` if none arrived. */
  readonly ttftMs: number | null;
  /** Time from request start to the `done` frame. */
  readonly totalMs: number;
  /** Normalized cumulative usage, or `null` when the model reported none. */
  readonly usage: UsageInfo | null;
  /** `"stop"`, `"length"`, or a model-reported value passed through as-is. */
  readonly finishReason: string;
}

/** Outcome reported to {@link ChatStreamCallbacks.onAborted} when the consumer cancels early. */
export interface ChatStreamAbortResult {
  readonly ttftMs: number | null;
  readonly totalMs: number;
}

/** Outcome reported to {@link ChatStreamCallbacks.onFailed} for a post-first-byte failure. */
export interface ChatStreamFailureResult {
  readonly ttftMs: number | null;
  readonly totalMs: number;
  readonly status: number;
  readonly detail: string;
}

/**
 * Lifecycle hooks `src/worker/routes/chat.ts` uses to emit the structured logs
 * docs/05-AI-CHAT.md requires, without `src/worker/chat/stream.ts` itself needing to know about
 * Hono's context or the request logger. Every callback is optional and best-effort — a throwing
 * callback is not caught here, matching `cloudflareLogger()`'s own synchronous, non-throwing
 * logging calls.
 */
export interface ChatStreamCallbacks {
  /** Called once, the moment the first `thinking`/`answer` delta is about to be enqueued. */
  onFirstToken?: (ttftMs: number) => void;
  /** Called once the `done` frame has been enqueued and the stream is about to close normally. */
  onDone?: (result: ChatStreamDoneResult) => void;
  /** Called when the outgoing stream is cancelled by its consumer before completion. */
  onAborted?: (result: ChatStreamAbortResult) => void;
  /** Called once the `error` frame has been enqueued and the stream is about to close. */
  onFailed?: (result: ChatStreamFailureResult) => void;
}

/** Options controlling cancellation propagation and lifecycle logging for one turn's stream. */
export interface BuildChatStreamOptions {
  /** Aborted when the outgoing stream is cancelled, so `env.AI.run()` stops billable generation. */
  readonly abortController?: AbortController;
  /** Lifecycle hooks for structured logging (see {@link ChatStreamCallbacks}). */
  readonly callbacks?: ChatStreamCallbacks;
}

const encoder = new TextEncoder();

/** Encode one frame as a single SSE `data:` line, matching what `src/sse.ts` decodes. */
function encodeFrame(frame: ChatStreamFrame): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
}

/**
 * Build the streaming `POST /api/chat` response: writes `start` immediately, then `thinking`/
 * `answer` deltas as `src/worker/chat/inference.ts` produces them, then exactly one of `done` or
 * `error`, and returns the `Response` with `text/event-stream` headers and no buffering.
 *
 * This function never calls `ctx.waitUntil()` — the pump's lifetime is the returned response
 * stream's own lifetime, driven entirely by the stream's `start`/`cancel` callbacks, per
 * docs/05-AI-CHAT.md's explicit "do not hand the pump to `ctx.waitUntil()`" requirement.
 *
 * @param model The exact requested model ID, echoed in the `start` frame.
 * @param requestId Correlates this turn's frames with the structured logs
 * `src/worker/routes/chat.ts` emits via `options.callbacks`.
 * @param descriptor The resolved, validated model descriptor.
 * @param upstreamStream The already-open upstream stream from `inference.ts`'s
 * `openInferenceStream()` — by the time this function is called, any before-first-byte failure
 * has already been handled by the caller as an ordinary RFC 9457 response.
 * @param options Cancellation and logging hooks.
 * @returns The streaming `Response`.
 */
export function buildChatStreamResponse(
  model: string,
  requestId: string,
  descriptor: ModelDescriptor,
  upstreamStream: ReadableStream,
  options: BuildChatStreamOptions = {},
): Response {
  const startedAt = Date.now();
  let ttftMs: number | null = null;
  let finishReason = "stop";
  let usage: UsageInfo | null = null;
  const events = readInferenceEvents(descriptor, upstreamStream);

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encodeFrame({ type: "start", model, requestId }));

      try {
        for await (const event of events) {
          if (ttftMs === null && (event.answerDelta || event.thinkingDelta)) {
            ttftMs = Date.now() - startedAt;
            options.callbacks?.onFirstToken?.(ttftMs);
          }
          if (event.thinkingDelta) {
            controller.enqueue(
              encodeFrame({ type: "thinking", text: event.thinkingDelta }),
            );
          }
          if (event.answerDelta) {
            controller.enqueue(
              encodeFrame({ type: "answer", text: event.answerDelta }),
            );
          }
          if (event.usage) {
            usage = event.usage;
          }
          if (event.finishReason) {
            finishReason = event.finishReason;
          }
        }

        const totalMs = Date.now() - startedAt;
        controller.enqueue(
          encodeFrame({
            type: "done",
            finishReason,
            ttftMs: ttftMs ?? totalMs,
            totalMs,
            usage,
          }),
        );
        options.callbacks?.onDone?.({ ttftMs, totalMs, usage, finishReason });
        controller.close();
      } catch (error) {
        const totalMs = Date.now() - startedAt;
        const problem =
          error instanceof ProblemDetailsError
            ? error.problemDetails
            : {
                status: 502,
                title: "Inference failed",
                detail: "Workers AI inference failed.",
              };
        const detail = problem.detail ?? problem.title;
        controller.enqueue(
          encodeFrame({
            type: "error",
            status: problem.status,
            title: problem.title,
            detail,
          }),
        );
        options.callbacks?.onFailed?.({
          ttftMs,
          totalMs,
          status: problem.status,
          detail,
        });
        controller.close();
      }
    },

    async cancel(reason) {
      // Propagates cancellation two ways: aborting env.AI.run()'s own signal (so Workers AI stops
      // generating) and returning the events generator, which cascades into src/sse.ts's
      // decoder cancelling its upstream reader — see docs/05-AI-CHAT.md's requirement that a
      // stopped generation actually stops, rather than continuing to run (and bill) unread.
      options.abortController?.abort(reason);
      await events.return();
      options.callbacks?.onAborted?.({
        ttftMs,
        totalMs: Date.now() - startedAt,
      });
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
