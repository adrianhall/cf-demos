/**
 * @file Spike B — AI Gateway provisioning and dynamic routes as infrastructure
 * (docs/06-AGENTIC-CHAT.md, Section 9, Phase 0). Proves that a dynamic route's name can replace
 * a literal model ID in a real `env.AI.run()` call (Section 6.3), that the route's
 * platform-side conditional node actually steers the underlying model by request metadata
 * (Section 6, US-7), and that the resulting `aiGatewayLogId` can be exchanged for AI Gateway's
 * own authoritative cost/token figures via `env.AI.gateway(id).getLog()` (Section 6.6).
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
const GATEWAY_ID = "spike-01-dynroute";

/** The two dynamic route names provisioned by `infra/main.tf`. */
const ROUTES = {
  basic: "dynamic/spike-basic-route",
  governed: "dynamic/spike-governed-route",
  // A literal (non-dynamic) model ID through the same gateway — a control group proving
  // whether `env.AI.aiGatewayLogId` population depends on the model argument being a dynamic
  // route name specifically, per README.md/REPORT.md.
  direct: "@cf/google/gemma-4-26b-a4b-it",
} as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET /call?route=basic|governed&business=<value>&message=<text>
    //
    // Calls the named dynamic route through `env.AI.run()` — the binding form Spike B's aim
    // asks about, as opposed to the OpenAI-compatible HTTP endpoint (README.md documents why
    // both were tried: only the binding form populates `env.AI.aiGatewayLogId`, confirmed by
    // curl-ing the plain REST endpoint directly and finding no log-id-bearing header or body
    // field anywhere in its response).
    if (url.pathname === "/call") {
      const routeKey = url.searchParams.get("route");
      const route =
        routeKey === "basic" || routeKey === "governed" || routeKey === "direct"
          ? ROUTES[routeKey]
          : null;
      if (!route) {
        return Response.json(
          { error: "Use ?route=basic, ?route=governed, or ?route=direct" },
          { status: 400 },
        );
      }
      const business = url.searchParams.get("business");
      const message = url.searchParams.get("message") ?? "Reply with exactly one word: hello";

      const metadata: Record<string, string> = {};
      if (business) {
        metadata.business = business;
      }

      const startedAt = Date.now();
      try {
        // Cast through `Record<string, unknown>` per `Ai.run()`'s "unknown model" overload — a
        // dynamic route name is never a member of the generated `AiModelList`, so TypeScript
        // must be told this is the fallback (untyped input/output) call shape, not a typo of a
        // real model ID.
        const result = await env.AI.run(
          route as unknown as Exclude<string, never>,
          { messages: [{ role: "user", content: message }] } as Record<string, unknown>,
          {
            gateway: {
              id: GATEWAY_ID,
              metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
            },
          },
        );
        const durationMs = Date.now() - startedAt;

        return Response.json({
          route,
          metadataSent: metadata,
          aiGatewayLogId: env.AI.aiGatewayLogId,
          durationMs,
          result,
        });
      } catch (error) {
        console.error("[spike] env.AI.run failed", error);
        return Response.json(
          {
            route,
            metadataSent: metadata,
            aiGatewayLogId: env.AI.aiGatewayLogId,
            errorName: error instanceof Error ? error.constructor.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorCause:
              error instanceof Error && error.cause instanceof Error
                ? error.cause.message
                : undefined,
          },
          { status: 502 },
        );
      }
    }

    // GET /log?id=<aiGatewayLogId>
    //
    // Exchanges a log ID for AI Gateway's own logged cost/token figures (Section 6.6's
    // preferred cost source). Returns the raw `AiGatewayLog` shape and, separately, whether the
    // call threw (the "not yet available" signal Spike F must pin down exactly) so REPORT.md can
    // record both the success and failure shapes actually observed.
    if (url.pathname === "/log") {
      const logId = url.searchParams.get("id");
      if (!logId) {
        return Response.json({ error: "Use ?id=<aiGatewayLogId>" }, { status: 400 });
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
      "Spike B probe endpoints:\n" +
        "  GET /call?route=basic|governed[&business=leadership][&message=...]\n" +
        "  GET /log?id=<aiGatewayLogId>\n",
      { status: 404 },
    );
  },
};
