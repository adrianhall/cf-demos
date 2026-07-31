import type { UsageInfo } from "../../chat-protocol";

/**
 * Input to {@link buildInferenceLogFields}. Deliberately has **no field capable of holding
 * message content** — no `content`, `prompt`, `answer`, or `text` — so a caller cannot even
 * accidentally pass conversation text through to a log line; the structural guarantee comes from
 * this type, not from a runtime redaction step. See `log-fields.test.ts` for a direct assertion
 * of this property.
 */
export interface InferenceLogFieldsInput {
  /** Exact requested model ID. */
  readonly model: string;
  /** Correlates this turn's `ai_*` events with each other and with the `start` frame's ID. */
  readonly requestId: string;
  /** Number of messages in the validated conversation (including the new user turn). */
  readonly messageCount: number;
  /** Total character count across the validated conversation. */
  readonly totalCharacters: number;
  /** Time to first token, in milliseconds, when known at the time of this log line. */
  readonly ttftMs?: number | null;
  /** Total turn duration, in milliseconds, when known at the time of this log line. */
  readonly totalMs?: number;
  /** Normalized token usage, when known at the time of this log line. */
  readonly usage?: UsageInfo | null;
  /** The model's finish reason, when known at the time of this log line. */
  readonly finishReason?: string;
  /** RFC 9457 status code, for an `ai_inference_failed` log line. */
  readonly status?: number;
  /** RFC 9457 detail — always one of this Worker's own fixed, canned failure strings from
   * `src/worker/chat/inference.ts`'s error mapping, never raw upstream or user text. */
  readonly detail?: string;
}

/** The flattened structured-log payload {@link buildInferenceLogFields} produces. */
export interface InferenceLogFields {
  readonly model: string;
  readonly requestId: string;
  readonly messageCount: number;
  readonly totalCharacters: number;
  readonly ttftMs?: number;
  readonly totalMs?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly finishReason?: string;
  readonly status?: number;
  readonly detail?: string;
  // An index signature so this type is directly assignable to cloudflareLogger()'s
  // `LogContext` (`Record<string, unknown>`) parameter without a spread at every call site.
  readonly [key: string]: unknown;
}

/**
 * Build the structured-log payload for one `ai_prompt_submitted`, `ai_first_token`,
 * `ai_stream_completed`, `ai_stream_aborted`, or `ai_inference_failed` log line
 * (`src/worker/routes/chat.ts`). A pure function so its "never leaks content" guarantee is
 * directly unit-testable without a real logger or request.
 *
 * @param input Fields known at the point this log line is emitted. Every field is optional except
 * `model`/`requestId`/`messageCount`/`totalCharacters`, since different call sites in the turn's
 * lifecycle know different subsets (for example `ai_prompt_submitted` knows none of the timing or
 * usage fields yet).
 * @returns The flattened payload, omitting any field `input` did not provide rather than emitting
 * `null`/`undefined` noise.
 */
export function buildInferenceLogFields(
  input: InferenceLogFieldsInput,
): InferenceLogFields {
  return {
    model: input.model,
    requestId: input.requestId,
    messageCount: input.messageCount,
    totalCharacters: input.totalCharacters,
    ...(input.ttftMs !== undefined && input.ttftMs !== null
      ? { ttftMs: input.ttftMs }
      : {}),
    ...(input.totalMs !== undefined ? { totalMs: input.totalMs } : {}),
    ...(input.usage
      ? {
          promptTokens: input.usage.promptTokens,
          completionTokens: input.usage.completionTokens,
          totalTokens: input.usage.totalTokens,
        }
      : {}),
    ...(input.finishReason !== undefined
      ? { finishReason: input.finishReason }
      : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  };
}
