/**
 * @file `ToolRunner` — a minimal stand-in for the real demo's `ChatAgent` Durable Object
 * (docs/06-AGENTIC-CHAT.md Section 6.7, Spike C). Its one RPC method answers Spike C's central
 * questions: can a Durable Object sharing the main Worker script's `env` load and run a Dynamic
 * Worker through `env.LOADER` the same way the top-level `fetch()` handler could, and does
 * `ctx.exports` (needed to wire `EgressGateway` as `globalOutbound`, per
 * developers.cloudflare.com/dynamic-workers/usage/egress-control/) work directly inside a
 * Durable Object method, or must the gateway stub be threaded in from the Worker's own
 * `fetch()` call site (which definitely has a `ctx.exports`)?
 *
 * This is disposable spike code (docs/06-AGENTIC-CHAT.md, Section 8). See README.md for the
 * exact aim and REPORT.md for what running it actually showed.
 */
import { DurableObject } from "cloudflare:workers";
import { GET_URL_TOOL_MODULE } from "./get-url-tool-code";

/** The bindings `ToolRunner` needs, matching `wrangler.jsonc`. Regenerate with `wrangler types`. */
interface Env {
  LOADER: WorkerLoader;
}

/** Shape returned by `runGetUrlTool`, surfaced directly as the spike's JSON response. */
export interface ToolRunResult {
  /** Whether `this.ctx.exports` was itself a usable object inside the DO, with no threading. */
  ctxExportsAvailableInsideDurableObject: boolean;
  /** The error `this.ctx.exports` raised inside the DO, if accessing it was not usable. */
  ctxExportsErrorInsideDurableObject?: string;
  /** The Dynamic Worker's response status for the requested URL. */
  status: number;
  /** The Dynamic Worker's response body for the requested URL. */
  body: string;
}

export class ToolRunner extends DurableObject<Env> {
  /**
   * Runs the sandboxed `getUrl` tool against `targetUrl`, routed through `globalOutboundGateway`
   * — an `EgressGateway` stub obtained via `ctx.exports.EgressGateway()` at the Worker's own
   * `fetch()` call site (`src/index.ts`) and passed in as an ordinary RPC parameter. This works
   * because a Workers RPC stub can be embedded in any RPC call's arguments (the capability-based
   * model `developers.cloudflare.com/dynamic-workers/usage/bindings/` describes as "Cap'n Web"),
   * not only in a binding's own statically declared shape — confirmed live, see REPORT.md.
   */
  async runGetUrlTool(
    targetUrl: string,
    globalOutboundGateway: Fetcher,
  ): Promise<ToolRunResult> {
    let ctxExportsAvailableInsideDurableObject = false;
    let ctxExportsErrorInsideDurableObject: string | undefined;
    try {
      // Spike C's own probe (Section 8's stated open question): is `ctx.exports` reachable from
      // inside a Durable Object method at all, with no external threading? `DurableObjectState`'s
      // documented API surface (ctx.storage/ctx.id/ctx.waitUntil/ctx.blockConcurrencyWhile/...)
      // does not list `exports` — this is exactly what makes it worth checking empirically rather
      // than assuming either way. Cast through `unknown` deliberately: this reads an undocumented
      // (as of this spike) property, not one `DurableObjectState`'s shipped types declare.
      const exports = (this.ctx as unknown as { exports?: unknown }).exports;
      ctxExportsAvailableInsideDurableObject = exports !== undefined;
    } catch (error) {
      ctxExportsErrorInsideDurableObject = error instanceof Error ? error.message : String(error);
    }

    // Central question #1: can a Durable Object call `env.LOADER.get()` the same way a top-level
    // `fetch()` handler could? `this.env` is the same `Env` the Worker's own `fetch()` receives
    // (docs/06-AGENTIC-CHAT.md Section 6.2's "ChatAgent shares the main Worker script's env"),
    // so this line is the direct test.
    const worker = this.env.LOADER.get("get-url-tool", async () => ({
      compatibilityDate: "2026-07-29",
      mainModule: "index.js",
      modules: { "index.js": GET_URL_TOOL_MODULE },
      // Central question #2: the sandboxed tool's own fetch() is routed through the gateway
      // threaded in above, never straight to the network (Section 6.7's "deny by default, permit
      // deliberately" requirement, enforced at the platform layer, not only application code).
      globalOutbound: globalOutboundGateway,
    }));

    const response = await worker
      .getEntrypoint()
      .fetch(new Request(`https://get-url-tool.invalid/?url=${encodeURIComponent(targetUrl)}`));

    return {
      ctxExportsAvailableInsideDurableObject,
      ctxExportsErrorInsideDurableObject,
      status: response.status,
      body: await response.text(),
    };
  }
}
