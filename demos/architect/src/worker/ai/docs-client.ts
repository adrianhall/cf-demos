import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

/**
 * A short-lived outbound MCP client to Cloudflare's own public, **unauthenticated** documentation
 * server (docs/09D-ARCHITECT-AICHAT.md's Cloudflare Docs Tool), backing the AI chat's
 * `search_cloudflare_documentation` tool.
 *
 * **Deliberately not the Agents SDK's `MCPClientManager`** (`this.addMcpServer()`/`this.mcp`).
 * That manager exists to hold a *persistent* connection's state (OAuth tokens, reconnection,
 * subscriptions) across a long-lived `Agent` -- real value for a server that needs authorization
 * or needs to stay connected between calls, neither of which is true here: the target server is
 * public and stateless (confirmed in `docs/DECISIONS.md` #35: a bare `tools/call` succeeds with
 * no prior `initialize` on the same connection, i.e. a fresh server per request by its own
 * design), so a short-lived client that connects, calls one tool, and disconnects within the
 * same tool-call round is simpler and carries no state this module would otherwise need to keep
 * alive between chat turns or `DiagramSession` instances.
 *
 * **Failure-handling contract, split across two exports**: {@link searchCloudflareDocumentation}
 * itself may throw/reject on a genuine failure (timeout, network error, a tool-level `isError`
 * result, a malformed response it cannot parse into any result) -- that is intentional and is
 * what makes each failure mode independently testable. {@link searchCloudflareDocumentationSafe}
 * is the layer responsible for turning any such rejection into the non-fatal outcome
 * docs/09D-ARCHITECT-AICHAT.md's Cloudflare Docs Tool section specifies ("a docs lookup that
 * times out or errors is treated as non-fatal to the turn ... never a thrown error that aborts
 * the whole chat turn"): `chat-engine.ts` (Phase 23) is expected to call the `*Safe` wrapper, not
 * the throwing function, precisely so one flaky docs lookup can never abort an otherwise-healthy
 * multi-round tool-calling turn.
 */

/** Cloudflare's own public documentation MCP server -- no OAuth or API token required (confirmed
 * live in `docs/DECISIONS.md` #35). */
const DOCS_MCP_SERVER_URL = "https://docs.mcp.cloudflare.com/mcp";

/** Per-call timeout, covering both the connection handshake and the single `callTool()` --
 * generous enough for a real cross-internet round trip, short enough that a hung upstream server
 * can never stall an entire multi-round chat turn indefinitely. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Maximum character length of a normalized result's `snippet` -- the upstream server's own
 * `<text>` blocks can be very long (multiple paragraphs of a documentation page); a "Sources"
 * list rendered under a chat message needs a short excerpt, not the full page. */
const SNIPPET_MAX_LENGTH = 280;

/** One normalized documentation search result, surfaced to both the calling model (as a tool
 * result) and the chat UI (as a clickable "Sources" entry). */
export interface DocumentationResult {
  /** Page title. */
  title: string;
  /** Full URL to the documentation page. */
  url: string;
  /** Short excerpt of the page's matched content, truncated to {@link SNIPPET_MAX_LENGTH}
   * characters. */
  snippet: string;
}

/**
 * Matches one `<result><url>...</url><title>...</title><text>...</text></result>` block --
 * the docs server's own real (non-JSON) text-content format for
 * `search_cloudflare_documentation`, confirmed by a live, unauthenticated call in
 * `docs/DECISIONS.md` #35 and by a direct raw `curl` against {@link DOCS_MCP_SERVER_URL} during
 * this phase's own implementation: the tool's single `text` content block is several of these
 * blocks concatenated back-to-back, one per ranked result, with no separator between
 * `</result>` and the next `<result>`.
 */
const RESULT_BLOCK_PATTERN =
  /<result>\s*<url>([\s\S]*?)<\/url>\s*<title>([\s\S]*?)<\/title>\s*<text>([\s\S]*?)<\/text>\s*<\/result>/g;

/**
 * Truncate a snippet to {@link SNIPPET_MAX_LENGTH} characters, trimming surrounding whitespace
 * first (the upstream `<text>` blocks are indented/wrapped Markdown-ish prose).
 *
 * @param text Raw text to truncate.
 * @param maxLength Maximum resulting length, including the trailing ellipsis when truncated.
 * @returns The trimmed, possibly-truncated text.
 */
function truncateSnippet(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength
    ? `${trimmed.slice(0, maxLength - 1)}…`
    : trimmed;
}

/**
 * Parse every `<result>` block out of one text-content string into {@link DocumentationResult}
 * values. Deliberately tolerant: a string with no matching blocks at all (a malformed or
 * unexpected upstream response) simply yields an empty array rather than throwing -- graceful
 * handling of a malformed response is this function's whole job, not a caller's.
 *
 * @param text One `text`-type content block's raw text.
 * @returns Every well-formed result block found, in the order they appeared.
 */
function parseResultBlocks(text: string): DocumentationResult[] {
  const results: DocumentationResult[] = [];
  for (const [, url, title, body] of text.matchAll(RESULT_BLOCK_PATTERN)) {
    results.push({
      snippet: truncateSnippet(body, SNIPPET_MAX_LENGTH),
      title: title.trim(),
      url: url.trim(),
    });
  }
  return results;
}

/**
 * Search Cloudflare's own current product documentation via its public MCP server. Opens a
 * fresh `Client` + `StreamableHTTPClientTransport`, performs exactly one `callTool()`, and closes
 * the client again before returning -- see this module's top-of-file JSDoc for why a persistent
 * connection is deliberately not used.
 *
 * **This function throws on failure** -- a connection/request timeout (bounded by
 * {@link REQUEST_TIMEOUT_MS}), a network error, a tool-level `isError` result, or (in the
 * genuinely-unexpected case of the upstream server changing its response shape entirely, e.g. an
 * empty `content` array) simply resolves to an empty array rather than throwing, since a response
 * this function can parse zero results out of is not itself an error. Callers that need the
 * non-fatal "documentation search is currently unavailable" contract
 * docs/09D-ARCHITECT-AICHAT.md's Cloudflare Docs Tool section specifies should call
 * {@link searchCloudflareDocumentationSafe} instead of this function directly.
 *
 * @param query Free-text search query.
 * @returns Every ranked documentation result the server returned, normalized to
 * `{ title, url, snippet }`. Never `undefined`; an empty array when the server returns no
 * results (or a response this function cannot parse any result out of).
 * @throws {Error} On a connection/request timeout, network error, or a tool-level `isError`
 * result from the upstream server.
 */
export async function searchCloudflareDocumentation(
  query: string,
): Promise<DocumentationResult[]> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const transport = new StreamableHTTPClientTransport(
    new URL(DOCS_MCP_SERVER_URL),
  );
  const client = new Client({ name: "architect-ai-chat", version: "1.0.0" });

  try {
    await client.connect(transport, { signal });
    const result = await client.callTool(
      { arguments: { query }, name: "search_cloudflare_documentation" },
      { signal },
    );

    if (result.isError) {
      throw new Error(
        `search_cloudflare_documentation reported a tool-level error for query "${query}".`,
      );
    }

    const results: DocumentationResult[] = [];
    for (const block of result.content) {
      if (block.type === "text") {
        results.push(...parseResultBlocks(block.text));
      }
    }
    return results;
  } finally {
    await client.close();
  }
}

/** The exact fallback text docs/09D-ARCHITECT-AICHAT.md's Cloudflare Docs Tool section specifies:
 * "the tool result returned to the model is a plain 'documentation search is currently
 * unavailable' string." */
export const DOCUMENTATION_SEARCH_UNAVAILABLE_MESSAGE =
  "Documentation search is currently unavailable.";

/**
 * Result of {@link searchCloudflareDocumentationSafe} -- a discriminated union so
 * `chat-engine.ts` (Phase 23) can tell a genuine result set (even an empty one) apart from the
 * non-fatal failure fallback without needing a `try`/`catch` of its own.
 */
export type DocumentationSearchOutcome =
  | { ok: true; results: DocumentationResult[] }
  | { ok: false; message: string };

/**
 * Non-fatal wrapper around {@link searchCloudflareDocumentation} -- the function `chat-engine.ts`
 * (Phase 23) is expected to call from inside its tool-calling loop. Catches every rejection
 * {@link searchCloudflareDocumentation} can throw (timeout, network error, tool-level error) and
 * reports {@link DOCUMENTATION_SEARCH_UNAVAILABLE_MESSAGE} instead, so one flaky docs lookup can
 * never abort an otherwise-healthy chat turn (docs/09D-ARCHITECT-AICHAT.md's Cloudflare Docs
 * Tool: "a docs lookup that times out or errors is treated as non-fatal to the turn").
 *
 * @param query Free-text search query.
 * @returns `{ ok: true, results }` on success (including a genuinely empty result set); `{ ok:
 * false, message: DOCUMENTATION_SEARCH_UNAVAILABLE_MESSAGE }` on any failure. Never throws.
 */
export async function searchCloudflareDocumentationSafe(
  query: string,
): Promise<DocumentationSearchOutcome> {
  try {
    const results = await searchCloudflareDocumentation(query);
    return { ok: true, results };
  } catch {
    return { ok: false, message: DOCUMENTATION_SEARCH_UNAVAILABLE_MESSAGE };
  }
}
