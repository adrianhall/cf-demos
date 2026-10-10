-- Per-turn cost ledger (docs/06-AGENTIC-CHAT.md Section 6.4/6.6, Phase 6, US-5). One row per
-- completed turn: an immediately-available local estimate (`cost_source = 'estimated'`),
-- later upgraded in place to AI Gateway's own authoritative logged figures
-- (`cost_source = 'gateway'`) once `ChatAgent.reconcileUsage()` finds the matching log row.
-- `correlation_id` is the UUID minted before `env.AI.run()` and is the only reliable way to
-- find that row back (Spike F -- `env.AI.aiGatewayLogId` is always `null` for a dynamic-route
-- call), so it must be unique: exactly one `chat_usage` row is ever written per turn.
CREATE TABLE chat_usage (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  cost_source TEXT NOT NULL CHECK (cost_source IN ('estimated', 'gateway')),
  correlation_id TEXT NOT NULL,
  gateway_log_id TEXT,
  reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX chat_usage_chat_id_idx ON chat_usage (chat_id);
CREATE UNIQUE INDEX chat_usage_correlation_id_idx ON chat_usage (correlation_id);
