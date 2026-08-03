/**
 * @file The `getUrl` tool's own code (docs/06-AGENTIC-CHAT.md Section 6.7), passed as a source
 * string to `env.LOADER.get()`/`.load()` — Dynamic Workers accept code as strings in a `modules`
 * object, not as an imported module graph (developers.cloudflare.com/dynamic-workers/
 * getting-started/#supported-languages), so this is deliberately a template string, not a
 * TypeScript file the bundler resolves.
 *
 * This sandboxed Worker never sees the `EgressGateway` class, the allow-list, or any credential —
 * it only ever calls the ordinary global `fetch()`. Every one of those calls is intercepted by
 * whatever `globalOutbound` the loader Worker configured (`ToolRunner`'s `runGetUrlTool`, Section
 * 6.7's "deny by default, permit deliberately" model) before it ever reaches the real network.
 */
export const GET_URL_TOOL_MODULE = `
export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return new Response("Missing ?url= query parameter.", { status: 400 });
    }
    try {
      const response = await fetch(target);
      const body = await response.text();
      return new Response(body, { status: response.status });
    } catch (error) {
      // A blocked globalOutbound gateway call surfaces here as a thrown exception, not merely
      // a non-2xx response (docs/06-AGENTIC-CHAT.md Section 6.7's finding, confirmed in
      // REPORT.md) — this tool must therefore catch it and turn it into an ordinary Response
      // itself, exactly as the real getUrl tool's model-facing behavior must (US-9's "the agent
      // explains the refusal rather than failing silently or crashing the turn").
      return new Response(
        "getUrl tool error: " + (error instanceof Error ? error.message : String(error)),
        { status: 502 },
      );
    }
  },
};
`;
