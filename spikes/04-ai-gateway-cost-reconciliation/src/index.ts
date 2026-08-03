/**
 * @file Spike F — AI Gateway cost/log reconciliation (docs/06-AGENTIC-CHAT.md, Section 9, Phase
 * 0). Spike B (`spikes/01-ai-gateway-dynamic-routing/REPORT.md`) confirmed `env.AI.aiGatewayLogId`
 * is `null` for every call whose model argument is a dynamic route name — every real turn from
 * Phase 4 onward — so Section 6.6's reconciliation design (`this.schedule("reconcileUsage", {
 * gatewayLogId: env.AI.aiGatewayLogId })`) cannot work as originally written. This spike proves a
 * replacement: attach a unique per-turn value in `gateway.metadata`, then correlate it against
 * `GET .../ai-gateway/gateways/{id}/logs`'s `metadata.value` filter (this repo's `.env` credentials
 * drive that half of the probe directly — see `scripts/probe.mjs` — since the `AiGateway` binding
 * class has no list-logs method at all, only `getLog(id)`/`patchLog(id)`/`getUrl()`, confirmed by
 * reading the generated `worker-configuration.d.ts`).
 *
 * This Worker exposes only the `env.AI.run()` half of that experiment — the log-list correlation
 * and lag measurement live entirely in `scripts/probe.mjs`, run directly against the real account
 * REST API with this repo's own `.env` credentials, per Section 8's "reuse the root .env" rule.
 *
 * This is disposable spike code (docs/06-AGENTIC-CHAT.md, Section 8) — it answers one question
 * against the real account and is exempt from the demo contract in AGENTS.md. See README.md for
 * the exact aim and REPORT.md for what running it actually showed.
 */

/** The Worker's declared bindings, matching `wrangler.jsonc`. Regenerate with `wrangler types`. */
interface Env {
  AI: Ai;
}

/** The AI Gateway id provisioned by `infra/main.tf` — must match `local.ai_gateway_id` there. */
const GATEWAY_ID = "spike-04-cost-recon";

/** The dynamic route name provisioned by `infra/main.tf`. */
const ROUTE = "dynamic/spike-cost-recon-route";

/**
 * Calls the dynamic route through `env.AI.run()`, attaching `requestId` (and, optionally,
 * `business`) as AI Gateway custom metadata (max five entries per request, all string/number/
 * boolean — `env.AI.gateway()`'s own documented limit). `requestId` is the correlation key
 * `scripts/probe.mjs` polls the logs-list API for; a fresh, high-entropy UUID per call is
 * deliberate (Section 3 of REPORT.md: the logs-list API's `metadata.value` filter matches a value
 * anywhere in a log row's metadata map, independent of which key it was stored under, so only a
 * value unlikely to collide with anything else in the gateway's history is safe to correlate on).
 */
async function callRoute(
  env: Env,
  requestId: string,
  business: string | undefined,
  message: string,
): Promise<{
  requestId: string;
  aiGatewayLogId: string | null;
  startedAt: string;
  durationMs: number;
  errorName?: string;
  errorMessage?: string;
}> {
  const metadata: Record<string, string> = { requestId };
  if (business) {
    metadata.business = business;
  }
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  try {
    // Cast per the `Ai.run()` "unknown model" overload — a dynamic route name is never a member
    // of the generated `AiModelList` (matches spikes/01-ai-gateway-dynamic-routing/src/index.ts).
    // `eventId: requestId` re-tests Spike B's separate, already-failed `cf-aig-event-id`/
    // `gateway.eventId` correlation attempt (spikes/01-ai-gateway-dynamic-routing/REPORT.md
    // Section 3) — sent alongside the metadata correlation this spike actually relies on, purely
    // to record in REPORT.md whether it now appears on the resulting log row's own `event_id`
    // field. It has no bearing on this spike's own correlation mechanism either way.
    await env.AI.run(
      ROUTE as unknown as Exclude<string, never>,
      { messages: [{ role: "user", content: message }] } as Record<string, unknown>,
      { gateway: { id: GATEWAY_ID, metadata, eventId: requestId } },
    );
    return {
      requestId,
      aiGatewayLogId: env.AI.aiGatewayLogId,
      startedAt,
      durationMs: Date.now() - startedAtMs,
    };
  } catch (error) {
    console.error("[spike] env.AI.run failed", { requestId, error });
    return {
      requestId,
      aiGatewayLogId: env.AI.aiGatewayLogId,
      startedAt,
      durationMs: Date.now() - startedAtMs,
      errorName: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET /call?requestId=<uuid>[&business=<value>][&message=<text>]
    //
    // A single dynamic-route call, tagged with the caller-supplied correlation id. Returns
    // immediately with whatever is available synchronously (`aiGatewayLogId`, expected `null` per
    // Spike B) — `scripts/probe.mjs` does the actual log-list polling afterward.
    if (url.pathname === "/call") {
      const requestId = url.searchParams.get("requestId");
      if (!requestId) {
        return Response.json({ error: "Use ?requestId=<uuid>" }, { status: 400 });
      }
      const business = url.searchParams.get("business") ?? undefined;
      const message =
        url.searchParams.get("message") ?? `Reply with exactly one word: hello (${requestId})`;
      const result = await callRoute(env, requestId, business, message);
      return Response.json(result);
    }

    // GET /call-concurrent?n=<count>
    //
    // Fires `n` dynamic-route calls concurrently (`Promise.all`, all within this one Worker
    // invocation) — proves whether `env.AI.run()` calls genuinely in flight at the same time
    // within the same isolate can still be told apart afterward by their own distinct
    // `requestId` metadata, or whether the demo must serialize such calls (Spike F's aim). Each
    // call gets its own server-generated `requestId`, returned so `scripts/probe.mjs` can poll
    // for all of them independently.
    if (url.pathname === "/call-concurrent") {
      const n = Number(url.searchParams.get("n") ?? "3");
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        return Response.json({ error: "Use ?n=<1-10>" }, { status: 400 });
      }
      const calls = Array.from({ length: n }, (_, i) => {
        const requestId = crypto.randomUUID();
        return callRoute(
          env,
          requestId,
          undefined,
          `Reply with exactly one word: hello (${requestId}, concurrent slot ${i})`,
        );
      });
      const results = await Promise.all(calls);
      return Response.json({ results });
    }

    // GET /log?id=<logId>
    //
    // Exchanges a log ID (found via `scripts/probe.mjs`'s logs-list correlation, since
    // `aiGatewayLogId` itself is null for a dynamic-route call) for AI Gateway's own logged
    // cost/token figures via the binding's `getLog()` — confirms the binding's documented method
    // still works once a real id is known by another means, and re-verifies Spike B's finding
    // about `getLog()`'s "not yet available"/"not found" signal shape.
    if (url.pathname === "/log") {
      const logId = url.searchParams.get("id");
      if (!logId) {
        return Response.json({ error: "Use ?id=<logId>" }, { status: 400 });
      }
      try {
        const log = await env.AI.gateway(GATEWAY_ID).getLog(logId);
        return Response.json({ ok: true, log });
      } catch (error) {
        return Response.json({
          ok: false,
          errorName: error instanceof Error ? error.constructor.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return new Response(
      "Spike F probe endpoints:\n" +
        "  GET /call?requestId=<uuid>[&business=<value>][&message=...]\n" +
        "  GET /call-concurrent?n=<1-10>\n" +
        "  GET /log?id=<logId>\n",
      { status: 404 },
    );
  },
};
