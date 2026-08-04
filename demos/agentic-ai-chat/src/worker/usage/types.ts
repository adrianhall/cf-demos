/**
 * Which figure a `chat_usage` row's cost/token columns currently hold (docs/06-AGENTIC-CHAT.md
 * Section 6.6): `"estimated"` is this demo's own immediately-available, locally-computed
 * pricing-table guess (`./pricing.ts`); `"gateway"` is AI Gateway's own authoritative, logged
 * figure, found asynchronously by `ChatAgent.reconcileUsage()` (`../ai-gateway/logs.ts`) and
 * written in place over the estimate once available. A row never reports both at once, and the
 * UI must always render which one it is currently showing -- never present an estimate as if it
 * were confirmed.
 */
export type CostSource = "estimated" | "gateway";

/**
 * One persisted `chat_usage` row (docs/06-AGENTIC-CHAT.md Section 6.4) -- the cost/token record
 * of exactly one completed turn, keyed by {@link correlationId} so `reconcileUsage()` can find
 * it back again without ever needing `env.AI.aiGatewayLogId` (`null` for every dynamic-route
 * call, per Spike B/F).
 */
export interface ChatUsageRow {
  /** Server-generated row id. */
  readonly id: string;
  /** The chat this turn belongs to -- also the owning `ChatAgent` Durable Object's instance
   * name. */
  readonly chatId: string;
  /** The model this turn was billed against: the route's currently-configured literal model id
   * at write time (`./pricing.ts`'s `modelIdForRoute()`), overwritten with AI Gateway's own
   * logged `model` field once {@link costSource} flips to `"gateway"`. */
  readonly model: string;
  /** Prompt (input) tokens for this turn. */
  readonly promptTokens: number;
  /** Completion (output) tokens for this turn. */
  readonly completionTokens: number;
  /** USD cost for this turn -- an estimate or AI Gateway's own authoritative figure, per
   * {@link costSource}. */
  readonly costUsd: number;
  /** Which figure {@link costUsd}/{@link promptTokens}/{@link completionTokens} currently
   * hold. */
  readonly costSource: CostSource;
  /** The UUID minted before this turn's `env.AI.run()` call and attached as AI Gateway
   * `metadata.correlationId` -- the sole correlation key `reconcileUsage()` can use (Spike F). */
  readonly correlationId: string;
  /** AI Gateway's own real log row id, populated only once reconciliation finds it; `null`
   * while {@link costSource} is still `"estimated"`. */
  readonly gatewayLogId: string | null;
  /** How many times `reconcileUsage()` has looked for this row's log entry and found nothing
   * yet (docs/06-AGENTIC-CHAT.md Section 6.6's bounded retry budget). */
  readonly reconcileAttempts: number;
  /** ISO 8601 timestamp this row was first written. */
  readonly createdAt: string;
  /** ISO 8601 timestamp of this row's most recent write (the initial insert, a reconciliation
   * attempt increment, or a successful reconciliation). */
  readonly updatedAt: string;
}

/**
 * A chat's (or, from `aggregateForOwner()`, one chat among several owned by the same identity)
 * running cost/token totals -- the aggregate projection `ChatAgent.State.usage` mirrors
 * (docs/06-AGENTIC-CHAT.md Section 6.6a) and `GET /api/chats` returns per chat for the sidebar.
 * Always recomputed from `chat_usage` (`UsageRepository.aggregateForChat()`/
 * `aggregateForOwner()`) -- never independently incremented -- so D1 stays the only place the
 * arithmetic happens.
 */
export interface ChatUsageSummary {
  /** Sum of every row's `cost_usd`, regardless of {@link CostSource} (Section 6.6: "always the
   * best available number"). */
  readonly totalCostUsd: number;
  /** Sum of every row's `prompt_tokens`. */
  readonly totalPromptTokens: number;
  /** Sum of every row's `completion_tokens`. */
  readonly totalCompletionTokens: number;
  /** Total number of completed turns (rows) contributing to this summary. */
  readonly turnCount: number;
  /** How many of those rows have `cost_source = 'gateway'` -- the numerator of the "N of M
   * turns confirmed by AI Gateway" indicator (Section 6.6a). */
  readonly confirmedTurnCount: number;
  /** The most recent row's `updated_at`, or `null` when {@link turnCount} is `0`. */
  readonly lastUpdatedAt: string | null;
}

/** A {@link ChatUsageSummary} with every figure zeroed -- a chat's `ChatAgent.initialState.usage`
 * before its first turn ever completes, and `aggregateForChat()`'s own result for a chat with no
 * `chat_usage` rows yet. */
export function emptyUsageSummary(): ChatUsageSummary {
  return {
    totalCostUsd: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    turnCount: 0,
    confirmedTurnCount: 0,
    lastUpdatedAt: null,
  };
}
