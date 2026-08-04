/**
 * @file `EgressGateway` -- the `WorkerEntrypoint` passed as the `getUrl` tool's sandboxed
 * Dynamic Worker's `globalOutbound` (docs/06-AGENTIC-CHAT.md Phase 10, US-9, Section 6.7).
 * Every outbound `fetch()` the sandboxed Dynamic Worker (`./sandboxed-fetch-worker.ts`)
 * attempts is intercepted here instead of reaching the network directly: an allow-listed
 * hostname is forwarded for real, everything else is denied with a `403` -- Dynamic Workers'
 * own "deny by default, permit deliberately" egress-control model
 * (developers.cloudflare.com/dynamic-workers/usage/egress-control/), confirmed to work from
 * inside a Durable Object by Spike C (`spikes/02-dynamic-workers-egress-control/REPORT.md`).
 *
 * This class must be exported from the main Worker module (`src/worker/index.ts`) -- Dynamic
 * Workers' `ctx.exports.<Name>()` loopback mechanism only resolves a class that is a top-level
 * export of the script `ctx` belongs to (Spike C, confirmed source-side by
 * `worker-configuration.d.ts`'s generated `Cloudflare.Exports` type, which is keyed off
 * `GlobalProps.mainModule`'s own exports).
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { isAllowedHost } from "./allowlist";

/**
 * Per-request identity `ChatAgent` scopes this gateway stub with (docs/06-AGENTIC-CHAT.md
 * Section 6.7: "attach a per-request identity (`ctx.props`) for scoping/auditing"). Threaded in
 * via `ctx.exports.EgressGateway({ props: { chatId } })`, never read from anything the
 * sandboxed Dynamic Worker's own code could set -- that code never sees this class at all, only
 * the `Fetcher` stub it was given as `globalOutbound`.
 */
export interface EgressGatewayProps {
  /** The chat whose `getUrl` tool call is making this outbound request, for the log line
   * below -- lets an operator correlate a blocked/allowed decision back to a specific
   * conversation in Workers Logs. */
  readonly chatId: string;
}

/**
 * Indirection seam so a unit test can replace the real network `fetch` with a fake one, without
 * touching the network at all (Spike C, confirmed live: "the gateway itself, independent of
 * `fetch()`, is unit-testable by injecting a fake `fetch`"). `EgressGateway.fetch()` calls
 * `networkFetch.impl(...)` rather than the bare global `fetch` -- an ES module's imported
 * `const` binding cannot be *reassigned* from another module, but the **object** it points to
 * can be *mutated* in place (`networkFetch.impl = fakeFetch`), which a test does instead.
 *
 * The default **must** be an arrow function wrapping `fetch`, not a bare `{ impl: fetch }`
 * reference -- Spike C hit this live: extracting `fetch` as a bare value and storing it on
 * another object loses the implicit `globalThis` receiver workerd's native `fetch`
 * implementation requires, throwing `Illegal invocation: function called with incorrect \`this\`
 * reference` the moment the allowed branch below actually calls it
 * (developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors). Wrapping
 * it in a closure preserves the correct receiver at the call site inside that closure's own
 * body.
 */
export const networkFetch: { impl: typeof fetch } = {
  impl: (request) => fetch(request),
};

/**
 * `globalOutbound` gateway for the `getUrl` tool's sandboxed Dynamic Worker
 * (docs/06-AGENTIC-CHAT.md Section 6.7). Denies by default; permits only
 * {@link ALLOWED_HOSTS} (`./allowlist.ts`). Every decision -- allowed or blocked -- is logged
 * with the destination host and the calling chat's id, never the response body (AGENTS.md's
 * Observability And Security section: "never log ... unnecessary personal data"). A plain
 * structured `console.log()`, not the toolkit's `cloudflareLogger()` -- that middleware only
 * exists on a Hono `Context`, and `EgressGateway` (a `WorkerEntrypoint`, not a route handler)
 * has none; this mirrors `ChatAgent`'s own established convention for structured logging from
 * non-Hono Worker code (`../agent/chat-agent.ts`).
 */
export class EgressGateway extends WorkerEntrypoint<Env, EgressGatewayProps> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const allowed = isAllowedHost(url.hostname);

    console.log(
      JSON.stringify({
        event: "egress_gateway_decision",
        chatId: this.ctx.props?.chatId ?? null,
        host: url.hostname,
        allowed,
      }),
    );

    if (!allowed) {
      return new Response(
        `Egress blocked: "${url.hostname}" is not allow-listed.`,
        {
          status: 403,
        },
      );
    }

    return networkFetch.impl(request);
  }
}
