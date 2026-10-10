/**
 * The sole place this demo calls the Cloudflare REST API directly instead of a binding
 * (docs/06-AGENTIC-CHAT.md Section 6.6): the `AiGateway` binding only exposes
 * `getLog(id)`/`patchLog(id, data)`/`getUrl(provider)` -- there is no binding method to *list*
 * logs, which is the only way to find a dynamic-route call's log row at all (Spike B/F:
 * `env.AI.aiGatewayLogId` is `null` for every dynamic-route call, and `gateway.eventId`/
 * `cf-aig-event-id` never lands on the resulting row's `event_id` field either). Isolating this
 * one REST call behind {@link findLogByCorrelationId} keeps that exception contained and
 * independently mockable in tests, rather than scattering `fetch()` calls through `ChatAgent`.
 */

/** AI Gateway's own logged figures for the one log row matching a correlation id, mapped from
 * the REST response's field names (`tokens_in`/`tokens_out`/`cost` -- Spike B/F confirmed these
 * are **not** `prompt_tokens`/`completion_tokens`/`cost_usd`, despite this demo's own D1 column
 * names looking similar). */
export interface AiGatewayLogMatch {
  /** AI Gateway's own real log row id. */
  readonly gatewayLogId: string;
  /** The literal model this call actually resolved to, per AI Gateway's own log row. */
  readonly model: string;
  /** AI Gateway's own logged input token count. */
  readonly tokensIn: number;
  /** AI Gateway's own logged output token count. */
  readonly tokensOut: number;
  /** AI Gateway's own logged, authoritative USD cost. */
  readonly costUsd: number;
}

/** One row of the logs-list REST endpoint's `result` array -- only the fields this demo reads. */
interface RawLogRow {
  id: string;
  model: string;
  tokens_in?: number;
  tokens_out?: number;
  cost?: number;
}

/** The logs-list REST endpoint's response envelope shape. */
interface LogsListResponse {
  success: boolean;
  result?: RawLogRow[];
  errors?: unknown;
}

/** Options for {@link findLogByCorrelationId}. */
export interface FindLogByCorrelationIdOptions {
  /** Cloudflare account id the gateway belongs to (`env.CLOUDFLARE_ACCOUNT_ID`). */
  readonly accountId: string;
  /** The AI Gateway id this chat's turns are routed through (`env.AI_GATEWAY_ID`). */
  readonly gatewayId: string;
  /** Cloudflare API token with permission to read this gateway's logs
   * (`env.CLOUDFLARE_API_TOKEN`, a Wrangler secret -- Section 6.6: `AI` alone does not cover
   * this REST call). */
  readonly apiToken: string;
  /** Injectable `fetch` seam for tests (Spike C's confirmed "wrap the seam in a closure, inject
   * a fake implementation" pattern -- storing a bare reference to the global `fetch` on a plain
   * object and calling it later throws `Illegal invocation` inside `workerd`; a closure that
   * itself calls the real global `fetch` does not have that problem). Defaults to the real
   * global `fetch`. */
  readonly fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>;
}

/** Default {@link FindLogByCorrelationIdOptions.fetchImpl} -- a closure invoking the real global
 * `fetch`, per Spike C's confirmed-safe pattern. */
const defaultFetchImpl = (url: URL, init: RequestInit): Promise<Response> =>
  fetch(url, init);

/**
 * Find the one AI Gateway log row carrying `correlationId` in its `metadata` map, using the
 * logs-list REST endpoint's own `filters` query parameter (docs/06-AGENTIC-CHAT.md Section 6.6,
 * Spike F). `correlationId` must already be globally unique on its own: the endpoint's
 * `metadata.value` filter is an independent existence check across the whole metadata map, not
 * paired to a specific key, so this is only safe to call with a per-turn UUID, never a reused
 * value such as a chat id or a `business` segment name.
 *
 * @param correlationId The UUID minted before this turn's `env.AI.run()` call and attached as
 * `gateway.metadata.correlationId`.
 * @param options Account/gateway/credentials for the REST call, plus an optional injectable
 * `fetch` for tests.
 * @returns The matching log's figures, or `null` when no row has been logged for this
 * correlation id yet -- Section 6.6's "not yet available" signal for this path; there is no
 * thrown error or `404` the way the binding's `getLog()` has for an unknown id.
 * @throws {Error} When the REST call itself fails (a non-2xx HTTP status, or the response body's
 * own `success: false`) -- distinct from "not yet available", since this signals a genuine
 * request problem (credentials, network) rather than a row that simply has not landed yet. The
 * caller (`ChatAgent.reconcileUsage()`) treats both the same way for its own bounded retry
 * budget, but logs them differently.
 */
export async function findLogByCorrelationId(
  correlationId: string,
  options: FindLogByCorrelationIdOptions,
): Promise<AiGatewayLogMatch | null> {
  const filters = JSON.stringify([
    { key: "metadata.value", operator: "eq", value: [correlationId] },
  ]);
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai-gateway/gateways/${options.gatewayId}/logs`,
  );
  url.searchParams.set("per_page", "1");
  url.searchParams.set("order_by", "created_at");
  url.searchParams.set("order_by_direction", "desc");
  url.searchParams.set("filters", filters);

  const fetchImpl = options.fetchImpl ?? defaultFetchImpl;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${options.apiToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `AI Gateway logs-list request failed with status ${response.status}.`,
    );
  }
  const body = (await response.json()) as LogsListResponse;
  if (!body.success) {
    throw new Error(
      `AI Gateway logs-list request reported failure: ${JSON.stringify(body.errors)}`,
    );
  }

  const [row] = body.result ?? [];
  if (!row) {
    return null;
  }
  return {
    gatewayLogId: row.id,
    model: row.model,
    tokensIn: row.tokens_in ?? 0,
    tokensOut: row.tokens_out ?? 0,
    costUsd: row.cost ?? 0,
  };
}
