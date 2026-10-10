import type { UsageInfo } from "../../../chat-protocol";

/**
 * One message in the exact shape sent to `env.AI.run()`, including the server-owned system
 * prompt `src/worker/chat/validation.ts` prepends — unlike the client-facing `ChatMessage`
 * (`src/chat-protocol.ts`), which never allows `"system"`.
 */
export interface AiChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** Clamped generation parameters, already validated against the selected model's bounds. */
export interface AdapterParams {
  readonly temperature: number;
  readonly maxTokens: number;
}

/**
 * One already-JSON-parsed upstream SSE frame, normalized by an adapter's `readChunk()`. Every
 * field is optional because most frames carry only one kind of information (a single answer
 * delta, or only a terminal `usage` total) — see docs/DECISIONS.md #10 for why `usage` cannot be
 * assumed final on every chunk that carries it.
 */
export interface NormalizedChunk {
  /** Answer text produced by this chunk, if any. For `reasoning: "inline-think-tags"` models
   * (`src/models.ts`), this is the *unsplit* combined text — `src/worker/chat/reasoning.ts`
   * separates it from `thinkingDelta` downstream, not this function. */
  answerDelta?: string;
  /** Reasoning text produced by this chunk, if any. Populated here only when the upstream JSON
   * already separates it (`reasoning_content`) — never for the inline-think-tags mechanism. */
  thinkingDelta?: string;
  /** Normalized token usage, when this chunk reported one. See docs/DECISIONS.md #10: only the
   * *last* chunk carrying `usage` before `[DONE]` is the true cumulative total for the turn. */
  usage?: UsageInfo;
  /** The model's finish reason (`"stop"`, `"length"`, ...), when this chunk reported one. */
  finishReason?: string;
}
