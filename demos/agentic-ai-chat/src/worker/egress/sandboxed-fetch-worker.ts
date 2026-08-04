/**
 * @file The `getUrl` tool's own sandboxed code (docs/06-AGENTIC-CHAT.md Phase 10, US-9, Section
 * 6.7), passed as a source string to `env.LOADER.get()` -- Dynamic Workers accept code as
 * strings in a `modules` object, not as an imported module graph
 * (developers.cloudflare.com/dynamic-workers/getting-started/#supported-languages), so this is
 * deliberately a template string, not a TypeScript file the bundler resolves.
 *
 * This sandboxed Worker never sees `EgressGateway`, the allow-list, or any credential -- it
 * only ever calls the ordinary global `fetch()`. Every one of those calls is intercepted by
 * whichever `globalOutbound` the loading code configured
 * (`../agent/tools/get-url.ts`'s `createGetUrlTool()`) before it ever reaches the real network.
 */

/** Upper bound on how much of a fetched page's text this tool ever returns to the model --
 * generous for a page's readable content while keeping one `getUrl` call from flooding the
 * turn's own context window. Mirrors `../files/validation.ts`'s `MAX_CONTENT_BYTES` bound in
 * spirit (a fixed cap on model-facing content), applied here to fetched, not generated, text. */
export const MAX_FETCHED_CHARACTERS = 8_000;

/** `compatibilityDate` the sandboxed Dynamic Worker loads with -- kept identical to the main
 * Worker's own `wrangler.jsonc.tpl` value so both scripts run against the same `workerd`
 * feature set; there is no Terraform/deploy-time value to source this from instead, since
 * Dynamic Workers themselves need no Terraform resource (Section 6.7). */
export const SANDBOXED_FETCH_WORKER_COMPATIBILITY_DATE = "2026-08-03";

/**
 * The sandboxed Dynamic Worker's own source. Fetches the `?url=` query parameter and returns
 * its response body as bounded, truncated text.
 *
 * A blocked `globalOutbound` gateway call surfaces here as a **thrown exception** from
 * `fetch()`, not merely a non-2xx `Response` -- confirmed live by Spike C
 * (`spikes/02-dynamic-workers-egress-control/REPORT.md` Section 8) -- so this module's own
 * `try`/`catch` is load-bearing, not defensive boilerplate: without it, a blocked destination
 * would throw all the way out of the Dynamic Worker's `fetch()` handler instead of producing a
 * response the calling tool (`../agent/tools/get-url.ts`) can shape into a model-visible
 * refusal (US-9's "the agent explains the refusal rather than failing silently or crashing the
 * turn"). The caught error's own message is `EgressGateway`'s exact blocked-response body text
 * (`./gateway.ts`) when the block is what caused it, which is why this module deliberately
 * echoes that message back verbatim with a distinguishing `403` status rather than a generic
 * `502` -- `createGetUrlTool()` uses that status, not string-matching, to tell a genuine block
 * apart from any other fetch failure.
 */
export const SANDBOXED_FETCH_WORKER_MODULE = `
const MAX_CHARS = ${MAX_FETCHED_CHARACTERS};
export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return new Response("Missing ?url= query parameter.", { status: 400 });
    }
    try {
      const response = await fetch(target);
      const text = await response.text();
      const truncated = text.length > MAX_CHARS
        ? text.slice(0, MAX_CHARS) + "\\n\\n...(truncated)"
        : text;
      return new Response(truncated, { status: response.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // EgressGateway's own blocked-response text always starts with this exact prefix
      // (./gateway.ts) -- distinguishing a deliberate block from any other fetch failure (a DNS
      // error, a timeout, an upstream 5xx surfaced as a thrown error) by status code, not by
      // string-matching the message on the *outer* tool's own side.
      const blocked = message.startsWith("Egress blocked:");
      return new Response(message, { status: blocked ? 403 : 502 });
    }
  },
};
`;
