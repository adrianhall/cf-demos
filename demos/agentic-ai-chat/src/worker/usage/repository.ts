import type { ChatUsageRow, ChatUsageSummary } from "./types";
import { emptyUsageSummary } from "./types";

/** Input to {@link UsageRepository.insertEstimated}. */
export interface InsertEstimatedInput {
  /** The chat this turn belongs to. */
  readonly chatId: string;
  /** The model this turn's estimate was priced against (`../usage/pricing.ts`). */
  readonly model: string;
  /** This turn's prompt (input) token count. */
  readonly promptTokens: number;
  /** This turn's completion (output) token count. */
  readonly completionTokens: number;
  /** The locally computed USD estimate (`../usage/pricing.ts`'s `estimateCostUsd()`). */
  readonly costUsd: number;
  /** The UUID minted before this turn's `env.AI.run()` call -- the sole correlation key
   * `reconcileUsage()` can use to find this row's real AI Gateway log entry later. */
  readonly correlationId: string;
}

/** AI Gateway's own logged figures for one turn, as found by
 * `../ai-gateway/logs.ts`'s `findLogByCorrelationId()` -- the input to
 * {@link UsageRepository.reconcileWithGatewayLog}. */
export interface GatewayLogMatch {
  /** AI Gateway's own real log row id, stored for later reference. */
  readonly gatewayLogId: string;
  /** The literal model AI Gateway's own log row reports this call actually resolved to. */
  readonly model: string;
  /** AI Gateway's own logged input token count (`tokens_in`). */
  readonly tokensIn: number;
  /** AI Gateway's own logged output token count (`tokens_out`). */
  readonly tokensOut: number;
  /** AI Gateway's own logged, authoritative USD cost. */
  readonly costUsd: number;
}

/** Raw aggregate row shape shared by {@link UsageRepository.aggregateForChat} and
 * {@link UsageRepository.aggregateForOwner}. */
interface UsageAggregateDbRow {
  total_cost_usd: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  turn_count: number;
  confirmed_turn_count: number;
  last_updated_at: string | null;
}

/** Convert one aggregate query's row into a {@link ChatUsageSummary}. `first()`/`all()` on a
 * `COALESCE(SUM(...), 0)`/`COUNT(*)` query always returns a defined row even over zero matching
 * rows (D1/SQLite's own aggregate-function behavior), so `row` is only ever `null` here in a
 * scenario this repository does not construct -- treated as an empty summary regardless. */
function toSummary(row: UsageAggregateDbRow | null): ChatUsageSummary {
  if (row === null) {
    return emptyUsageSummary();
  }
  return {
    totalCostUsd: row.total_cost_usd,
    totalPromptTokens: row.total_prompt_tokens,
    totalCompletionTokens: row.total_completion_tokens,
    turnCount: row.turn_count,
    confirmedTurnCount: row.confirmed_turn_count,
    lastUpdatedAt: row.last_updated_at,
  };
}

/**
 * D1 persistence boundary for the per-chat cost ledger (docs/06-AGENTIC-CHAT.md Section 6.4/6.6,
 * Phase 6, US-5). Exposes separate, single-purpose operations -- `insertEstimated()`,
 * `reconcileWithGatewayLog()`, `incrementReconcileAttempts()`, `aggregateForChat()`,
 * `aggregateForOwner()` -- rather than one generic upsert, so each write/read path's intent is
 * explicit and independently testable, per the doc's own Phase 6 task 1.
 */
export class UsageRepository {
  /** @param database D1 capability used to query and update the ledger. */
  constructor(private readonly database: Pick<D1Database, "prepare">) {}

  /**
   * Insert one turn's immediately-available local estimate (`ChatAgent.recordTurnUsage()`,
   * called from `onFinish`). `cost_source` always starts as `'estimated'`; `reconcile_attempts`
   * always starts at `0`.
   *
   * @param input The turn's chat, model, token counts, USD estimate, and correlation id.
   * @returns The persisted row.
   */
  async insertEstimated(input: InsertEstimatedInput): Promise<ChatUsageRow> {
    const now = new Date().toISOString();
    const row: ChatUsageRow = {
      id: crypto.randomUUID(),
      chatId: input.chatId,
      model: input.model,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      costUsd: input.costUsd,
      costSource: "estimated",
      correlationId: input.correlationId,
      gatewayLogId: null,
      reconcileAttempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.database
      .prepare(
        `INSERT INTO chat_usage
           (id, chat_id, model, prompt_tokens, completion_tokens, cost_usd, cost_source,
            correlation_id, gateway_log_id, reconcile_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'estimated', ?, NULL, 0, ?, ?)`,
      )
      .bind(
        row.id,
        row.chatId,
        row.model,
        row.promptTokens,
        row.completionTokens,
        row.costUsd,
        row.correlationId,
        row.createdAt,
        row.updatedAt,
      )
      .run();
    return row;
  }

  /**
   * Upgrade a row in place with AI Gateway's own authoritative logged figures, flipping
   * `cost_source` to `'gateway'` (docs/06-AGENTIC-CHAT.md Section 6.6). Covers a failed-but-
   * logged turn identically to a successful one -- Spike F confirmed a failed dynamic-route call
   * still produces its own correlatable log row (`cost: 0, success: false`), which reconciles
   * through this same path with no special case.
   *
   * @param correlationId The turn's correlation id (matches the row written by
   * {@link insertEstimated}).
   * @param match AI Gateway's own logged figures, from `../ai-gateway/logs.ts`'s
   * `findLogByCorrelationId()`.
   * @returns Whether a row was actually updated -- `false` when the row no longer exists
   * (docs/06-AGENTIC-CHAT.md Section 11's "target has disappeared" tolerance).
   */
  async reconcileWithGatewayLog(
    correlationId: string,
    match: GatewayLogMatch,
  ): Promise<boolean> {
    const result = await this.database
      .prepare(
        `UPDATE chat_usage
         SET model = ?, prompt_tokens = ?, completion_tokens = ?, cost_usd = ?,
             cost_source = 'gateway', gateway_log_id = ?, updated_at = ?
         WHERE correlation_id = ?`,
      )
      .bind(
        match.model,
        match.tokensIn,
        match.tokensOut,
        match.costUsd,
        match.gatewayLogId,
        new Date().toISOString(),
        correlationId,
      )
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Record one more failed attempt to find this turn's log row (the logs-list endpoint's own
   * "not yet available" signal is simply an empty result, not a thrown error --
   * docs/06-AGENTIC-CHAT.md Section 6.6). Uses `UPDATE ... RETURNING` so the caller learns the
   * row's new attempt count in the same round trip, with no separate `SELECT`.
   *
   * @param correlationId The turn's correlation id.
   * @returns The row's new `reconcile_attempts` count, or `null` if the row no longer exists
   * (Section 11's "target has disappeared" tolerance) -- the caller must exit cleanly, not
   * treat `null` as an error.
   */
  async incrementReconcileAttempts(
    correlationId: string,
  ): Promise<number | null> {
    const result = await this.database
      .prepare(
        `UPDATE chat_usage
         SET reconcile_attempts = reconcile_attempts + 1, updated_at = ?
         WHERE correlation_id = ?
         RETURNING reconcile_attempts`,
      )
      .bind(new Date().toISOString(), correlationId)
      .run<{ reconcile_attempts: number }>();
    return result.results[0]?.reconcile_attempts ?? null;
  }

  /**
   * Re-aggregate one chat's own `chat_usage` rows -- the single query
   * `ChatAgent.refreshUsageState()` runs after every write to this ledger, so `state.usage`
   * (docs/06-AGENTIC-CHAT.md Section 6.6a) is always derived from D1, never independently
   * mutated.
   *
   * @param chatId Chat to aggregate.
   * @returns The chat's current totals, zeroed if it has no `chat_usage` rows yet.
   */
  async aggregateForChat(chatId: string): Promise<ChatUsageSummary> {
    const row = await this.database
      .prepare(
        `SELECT
           COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
           COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
           COALESCE(SUM(completion_tokens), 0) AS total_completion_tokens,
           COUNT(*) AS turn_count,
           COALESCE(SUM(CASE WHEN cost_source = 'gateway' THEN 1 ELSE 0 END), 0)
             AS confirmed_turn_count,
           MAX(updated_at) AS last_updated_at
         FROM chat_usage WHERE chat_id = ?`,
      )
      .bind(chatId)
      .first<UsageAggregateDbRow>();
    return toSummary(row);
  }

  /**
   * Re-aggregate every chat owned by one identity in a single query -- `GET /api/chats`'s
   * (Phase 3, extended by Phase 6) per-chat totals for the sidebar, without waking every one of
   * that identity's `ChatAgent` Durable Objects or issuing one query per chat.
   *
   * @param ownerEmail Verified Cloudflare Access identity whose chats to aggregate.
   * @returns A map from chat id to that chat's current totals. A chat with zero `chat_usage`
   * rows is simply absent from the map -- callers should treat a missing entry the same as
   * {@link emptyUsageSummary}.
   */
  async aggregateForOwner(
    ownerEmail: string,
  ): Promise<Map<string, ChatUsageSummary>> {
    const { results } = await this.database
      .prepare(
        `SELECT
           chat_usage.chat_id AS chat_id,
           COALESCE(SUM(chat_usage.cost_usd), 0) AS total_cost_usd,
           COALESCE(SUM(chat_usage.prompt_tokens), 0) AS total_prompt_tokens,
           COALESCE(SUM(chat_usage.completion_tokens), 0) AS total_completion_tokens,
           COUNT(*) AS turn_count,
           COALESCE(
             SUM(CASE WHEN chat_usage.cost_source = 'gateway' THEN 1 ELSE 0 END), 0
           ) AS confirmed_turn_count,
           MAX(chat_usage.updated_at) AS last_updated_at
         FROM chat_usage
         JOIN chats ON chats.id = chat_usage.chat_id
         WHERE chats.owner_email = ?
         GROUP BY chat_usage.chat_id`,
      )
      .bind(ownerEmail)
      .all<UsageAggregateDbRow & { chat_id: string }>();
    return new Map(results.map((row) => [row.chat_id, toSummary(row)]));
  }

  /**
   * Re-aggregate every user's own chats in a single query -- the admin console's ranked
   * user-cost table (docs/06-AGENTIC-CHAT.md Phase 7, US-6, `GET /api/admin/users`). Deliberately
   * a separate method from {@link aggregateForOwner} rather than that method with an optional
   * "no filter" mode: this repository's own Phase 6 convention is one single-purpose operation
   * per read/write path (this class's own top-level JSDoc), and this query's caller (an admin
   * route, never an ordinary user-facing one) is different enough to warrant its own name.
   *
   * @returns A map from owner email to that owner's current totals across every one of their
   * chats. An owner with zero `chat_usage` rows is simply absent from the map -- callers should
   * treat a missing entry the same as {@link emptyUsageSummary}.
   */
  async aggregateForAllUsers(): Promise<Map<string, ChatUsageSummary>> {
    const { results } = await this.database
      .prepare(
        `SELECT
           chats.owner_email AS owner_email,
           COALESCE(SUM(chat_usage.cost_usd), 0) AS total_cost_usd,
           COALESCE(SUM(chat_usage.prompt_tokens), 0) AS total_prompt_tokens,
           COALESCE(SUM(chat_usage.completion_tokens), 0) AS total_completion_tokens,
           COUNT(*) AS turn_count,
           COALESCE(
             SUM(CASE WHEN chat_usage.cost_source = 'gateway' THEN 1 ELSE 0 END), 0
           ) AS confirmed_turn_count,
           MAX(chat_usage.updated_at) AS last_updated_at
         FROM chat_usage
         JOIN chats ON chats.id = chat_usage.chat_id
         GROUP BY chats.owner_email`,
      )
      .all<UsageAggregateDbRow & { owner_email: string }>();
    return new Map(results.map((row) => [row.owner_email, toSummary(row)]));
  }

  /**
   * Re-aggregate cost grouped by every owner's admin-assigned `users.business`/`users.geo`
   * segment (docs/06-AGENTIC-CHAT.md Phase 7, US-6/Section 6.4) -- the admin console's two
   * segment reports (`GET /api/admin/reports/by-business`/`by-geo`). Shared by
   * {@link aggregateByBusiness}/{@link aggregateByGeo}, parameterized only by which `users`
   * column to group on -- `column` is always one of this module's own two hard-coded literals,
   * never request input, so interpolating it directly into the query text (D1/SQLite cannot
   * parameter-bind a column name) carries no injection risk.
   *
   * @param column Which `users` column to group by.
   * @returns A map from that column's value (`null` for a user with no segment assigned yet) to
   * the summed totals of every chat owned by a user in that segment.
   */
  private async aggregateGroupedByUserColumn(
    column: "business" | "geo",
  ): Promise<Map<string | null, ChatUsageSummary>> {
    const { results } = await this.database
      .prepare(
        `SELECT
           users.${column} AS segment,
           COALESCE(SUM(chat_usage.cost_usd), 0) AS total_cost_usd,
           COALESCE(SUM(chat_usage.prompt_tokens), 0) AS total_prompt_tokens,
           COALESCE(SUM(chat_usage.completion_tokens), 0) AS total_completion_tokens,
           COUNT(*) AS turn_count,
           COALESCE(
             SUM(CASE WHEN chat_usage.cost_source = 'gateway' THEN 1 ELSE 0 END), 0
           ) AS confirmed_turn_count,
           MAX(chat_usage.updated_at) AS last_updated_at
         FROM chat_usage
         JOIN chats ON chats.id = chat_usage.chat_id
         JOIN users ON users.email = chats.owner_email
         GROUP BY users.${column}`,
      )
      .all<UsageAggregateDbRow & { segment: string | null }>();
    return new Map(results.map((row) => [row.segment, toSummary(row)]));
  }

  /**
   * Cost aggregated by business segment (docs/06-AGENTIC-CHAT.md Phase 7, US-6,
   * `GET /api/admin/reports/by-business`).
   *
   * @returns A map from business segment (`null` for "unspecified") to that segment's summed
   * totals.
   */
  async aggregateByBusiness(): Promise<Map<string | null, ChatUsageSummary>> {
    return this.aggregateGroupedByUserColumn("business");
  }

  /**
   * Cost aggregated by geo segment (docs/06-AGENTIC-CHAT.md Phase 7, US-6,
   * `GET /api/admin/reports/by-geo`).
   *
   * @returns A map from geo segment (`null` for "unspecified") to that segment's summed totals.
   */
  async aggregateByGeo(): Promise<Map<string | null, ChatUsageSummary>> {
    return this.aggregateGroupedByUserColumn("geo");
  }
}
