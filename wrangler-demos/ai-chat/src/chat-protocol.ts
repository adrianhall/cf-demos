/**
 * @file The `/api/chat` wire contract: the request body shape and the discriminated
 * Server-Sent Events frame union the Worker emits. Imported by the Worker (to build responses),
 * the client (to send requests and parse responses), and tests (to construct fixtures), so this
 * is the single definition of the contract — see docs/05-AI-CHAT.md, "Streaming Protocol".
 */

/** One turn in the conversation sent from the browser. The Worker keeps no state between calls. */
export interface ChatMessage {
  /** `"system"` is deliberately not accepted here — see `src/worker/chat/validation.ts`. */
  readonly role: "user" | "assistant";
  /** Turn content. Length- and total-conversation-capped by `src/worker/chat/validation.ts`. */
  readonly content: string;
}

/**
 * `POST /api/chat` request body. `temperature`/`maxTokens` are optional: when omitted, the
 * selected model's descriptor default applies; when present, both are clamped — never
 * rejected — to that descriptor's bounds (see `src/worker/chat/validation.ts`).
 */
export interface ChatRequestBody {
  /** Must be an exact member of `src/models.ts`'s `MODEL_CATALOG`. */
  readonly model: string;
  /** Full conversation so far, including the new user turn. Must end in a `user` message. */
  readonly messages: readonly ChatMessage[];
  /** Optional sampling temperature, clamped to the selected model's descriptor bounds. */
  readonly temperature?: number;
  /** Optional output token limit, clamped to the selected model's descriptor bounds. */
  readonly maxTokens?: number;
}

/** Normalized token usage for one turn, or `null` when the model reported none. */
export interface UsageInfo {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/** Sent immediately once the Worker has an open upstream stream, before the first token. */
export interface ChatStartFrame {
  readonly type: "start";
  /** Echoes the request's exact model ID, for the client to label the turn. */
  readonly model: string;
  /** Correlates this turn with the structured logs `src/worker/chat/log-fields.ts` builds. */
  readonly requestId: string;
}

/** One reasoning-text delta. Only ever sent for a model whose descriptor declares reasoning. */
export interface ChatThinkingFrame {
  readonly type: "thinking";
  readonly text: string;
}

/** One answer-text delta. */
export interface ChatAnswerFrame {
  readonly type: "answer";
  readonly text: string;
}

/** Sent once, as the last frame of a turn that completed or was cancelled. */
export interface ChatDoneFrame {
  readonly type: "done";
  /** `"stop"`, `"length"`, `"cancelled"`, or a model-reported value passed through as-is. */
  readonly finishReason: string;
  /** Time from request start to the first `thinking`/`answer` delta, in milliseconds. */
  readonly ttftMs: number;
  /** Time from request start to this `done` frame, in milliseconds. */
  readonly totalMs: number;
  /** Normalized token usage, or `null` when the model reported none for this turn. */
  readonly usage: UsageInfo | null;
}

/** Sent when a failure occurs after the stream has already opened (status can no longer change). */
export interface ChatErrorFrame {
  readonly type: "error";
  readonly status: number;
  readonly title: string;
  readonly detail: string;
}

/** Every frame type the Worker may write to a `/api/chat` response body, one per `data:` line. */
export type ChatStreamFrame =
  | ChatStartFrame
  | ChatThinkingFrame
  | ChatAnswerFrame
  | ChatDoneFrame
  | ChatErrorFrame;
