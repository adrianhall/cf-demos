/**
 * @file The `EgressGateway` — the `WorkerEntrypoint` passed as a Dynamic Worker's
 * `globalOutbound` (docs/06-AGENTIC-CHAT.md Section 6.7, Spike C). Every `fetch()` the sandboxed
 * `getUrl`-tool Dynamic Worker attempts is intercepted here instead of reaching the network
 * directly: an allow-listed hostname is forwarded for real, everything else is blocked. Every
 * decision — allowed or blocked — is logged, per Section 6.7's "deny by default, permit
 * deliberately, log everything" requirement.
 *
 * This is disposable spike code (docs/06-AGENTIC-CHAT.md, Section 8) — it answers one question
 * against the real platform and is exempt from the demo contract in AGENTS.md. See README.md for
 * the exact aim and REPORT.md for what running it actually showed.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Hostnames the sandboxed `getUrl` tool may reach. A spike-only hard-coded allow-list; the real
 * demo's `EgressGateway` would read this from configuration, not a literal `Set`.
 */
export const ALLOWED_HOSTS = new Set(["example.com"]);

/**
 * Indirection seam that lets a unit test replace the real network `fetch` with a fake one, per
 * Spike C's own stated question ("confirm whether the gateway itself... is unit-testable by
 * injecting a fake fetch"). `EgressGateway.fetch()` calls `networkFetch.impl(...)` rather than
 * the bare global `fetch` — an ES module's imported `const` binding cannot be *reassigned* from
 * another module, but the **object** it points to can be *mutated* in place, so a test can do
 * `networkFetch.impl = fakeFetch` and observe the gateway's allow/block decision with zero real
 * network traffic (confirmed live — see REPORT.md, `egress-gateway.test.ts`).
 *
 * **Correction found live (see REPORT.md):** the default must be `(request) => fetch(request)`,
 * not a bare `fetch` reference. Assigning the extracted function itself (`{ impl: fetch }`) and
 * later calling `networkFetch.impl(request)` throws `Illegal invocation: function called with
 * incorrect \`this\` reference` inside workerd — the runtime's native `fetch` implementation
 * requires being invoked with the global scope as its receiver, exactly the class of bug
 * developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors documents.
 * Wrapping it in an arrow function preserves the correct implicit `globalThis` receiver at the
 * call site inside that arrow function's own body.
 */
export const networkFetch: { impl: typeof fetch } = { impl: (request) => fetch(request) };

/**
 * `globalOutbound` gateway for a Dynamic Worker (docs/06-AGENTIC-CHAT.md Section 6.7). Every
 * outbound `fetch()`/`connect()` a Dynamic Worker configured with this class as its
 * `globalOutbound` attempts is routed here instead of hitting the network directly — the Dynamic
 * Workers platform's own egress-control model (see
 * developers.cloudflare.com/dynamic-workers/usage/egress-control/). Denies by default; permits
 * only `ALLOWED_HOSTS`.
 */
export class EgressGateway extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const allowed = ALLOWED_HOSTS.has(url.hostname);

    // Log every decision — allowed or blocked — before acting on it (Section 6.7's "logs every
    // attempt (allowed and blocked)" requirement). A spike-only `console.log`; the real demo's
    // `getUrl` tool would use `cloudflareLogger()` per AGENTS.md's Observability section.
    console.log(
      JSON.stringify({
        msg: "egress-gateway decision",
        host: url.hostname,
        allowed,
      }),
    );

    if (!allowed) {
      return new Response(`Egress blocked: "${url.hostname}" is not allow-listed.`, {
        status: 403,
      });
    }

    return networkFetch.impl(request);
  }
}
