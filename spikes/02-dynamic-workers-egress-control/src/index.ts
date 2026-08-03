/**
 * @file Spike C — the minimal working `globalOutbound` egress-control pattern for a single
 * tool's outbound fetch (docs/06-AGENTIC-CHAT.md Section 6.7, Phase 0 Spike C). A `ToolRunner`
 * Durable Object (standing in for the real demo's `ChatAgent`) loads a Dynamic Worker running
 * the `getUrl` tool's code, whose `globalOutbound` is an `EgressGateway` `WorkerEntrypoint`
 * obtained via `ctx.exports.EgressGateway()` at this Worker's own `fetch()` call site and passed
 * into the Durable Object as an ordinary RPC parameter.
 *
 * This is disposable spike code (docs/06-AGENTIC-CHAT.md, Section 8) — it answers one question
 * against the real platform and is exempt from the demo contract in AGENTS.md. See README.md for
 * the exact aim and REPORT.md for what running it actually showed.
 */
import { EgressGateway } from "./egress-gateway";
import { ToolRunner } from "./tool-runner";

export { EgressGateway, ToolRunner };

/** The Worker's declared bindings, matching `wrangler.jsonc`. Regenerate with `wrangler types`. */
interface Env {
  LOADER: WorkerLoader;
  TOOL_RUNNER: DurableObjectNamespace<ToolRunner>;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) {
      return new Response(
        "Provide ?url=<target> — try ?url=https://example.com/ (allowed) or " +
          "?url=https://cloudflare.com/ (blocked).",
        { status: 400 },
      );
    }

    // `ctx.exports` (docs/06-AGENTIC-CHAT.md Section 6.7) is only ever obtained here, at the
    // top-level Worker's own `fetch()` call site — this is the one place Spike C confirmed it is
    // unconditionally available (see ToolRunner's own probe for whether it is *also* directly
    // reachable inside the Durable Object). The resulting stub is then passed into the Durable
    // Object as an RPC parameter, not re-derived inside it.
    const gateway = ctx.exports.EgressGateway({});

    const stub = env.TOOL_RUNNER.getByName("spike-c-single-instance");
    const result = await stub.runGetUrlTool(target, gateway);

    return Response.json(result);
  },
};
