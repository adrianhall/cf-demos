import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type {
  DocumentationResult,
  DocumentationSearchOutcome,
  DocumentationSearchPort
} from '../../application/ports/documentation-search.ts';

/**
 * @file The adapter behind `../../application/ports/documentation-search.ts`: a short-lived
 *   outbound MCP client against Cloudflare's own public documentation server. **Deliberately not
 *   the Agents SDK's `MCPClientManager`.** That manager exists to hold a _persistent_ connection's
 *   state — OAuth tokens, reconnection, subscriptions — which is real value for a server that needs
 *   authorization or needs to stay connected between calls. Neither is true here. The Phase 21
 *   spike confirmed against the live server that a bare `tools/call` with no prior `initialize` on
 *   that connection, and no `Authorization` header at all, returns real ranked results: the server
 *   does not enforce session continuity across HTTP requests. A client that connects, calls one
 *   tool and disconnects is therefore the _correct_ shape rather than merely the simple one, and it
 *   leaves nothing alive between chat turns or between Durable Object instances. **Why this file is
 *   the one that owns a timeout.** Everything else in this demo runs inside a request or a Durable
 *   Object method that the platform bounds. This is the only outbound call the chat makes, and an
 *   outbound call with no deadline inside a Durable Object is a standing cost risk: a pending
 *   operation keeps the object alive — and billed — for as long as it is pending, which the
 *   platform allows to run to around fifteen minutes. A hung documentation server must not be able
 *   to buy fifteen minutes of wall-clock duration charges, so the call carries its own deadline
 *   regardless of what any caller remembers to pass. **The two exports are a deliberate pair, not a
 *   convenience.** {@link searchCloudflareDocumentation} throws, which is what makes each failure
 *   mode independently assertable in a test. {@link searchCloudflareDocumentationSafe} — and the
 *   {@link McpDocumentationSearch} class the application tier actually receives — turns every one
 *   of those failures into the non-fatal outcome the port promises. A chat turn calls the safe one,
 *   always: a documentation lookup is an optimisation of an answer, never a precondition for it, so
 *   one unreachable server must cost the user a citation rather than a conversation.
 */

/**
 * Cloudflare's public documentation MCP server. Unauthenticated by design — no OAuth, no API token,
 * no binding — which is why this adapter needs no credential and why a Worker with no secrets can
 * still perform the lookup.
 */
const DOCS_MCP_SERVER_URL = 'https://docs.mcp.cloudflare.com/mcp';

/**
 * Deadline covering the connection handshake and the single tool call together.
 *
 * Ten seconds is generous for a cross-internet round trip to a search service and short enough that
 * a hung upstream cannot stall the turn the user is waiting on, let alone hold the Durable Object
 * open. It is a constant rather than a parameter because the right value is a property of this
 * transport, not of any particular caller, and a caller allowed to pass a longer one eventually
 * will.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Maximum length of a normalised result's snippet, in characters, including the ellipsis.
 */
const SNIPPET_MAX_LENGTH = 280;

/**
 * Name this client reports to the server during the handshake.
 */
const CLIENT_NAME = 'architect-ai-chat';

/**
 * Version this client reports to the server during the handshake.
 */
const CLIENT_VERSION = '1.0.0';

/**
 * The tool the documentation server exposes, named once so a typo cannot be made twice.
 */
const DOCS_TOOL_NAME = 'search_cloudflare_documentation';

/**
 * Matches one `<result><url>…</url><title>…</title><text>…</text></result>` block.
 *
 * This really is the wire format: the server answers with a single `text` content block holding
 * several of these concatenated back to back, with no separator between a `</result>` and the next
 * `<result>`, which the Phase 21 spike confirmed by raw request against the live server. It is not
 * JSON and must not be parsed as such.
 *
 * Non-greedy throughout, so two adjacent blocks match as two results rather than as one enormous
 * one, and `[\s\S]` rather than `.` so a body spanning several lines is captured whole.
 */
const RESULT_BLOCK_PATTERN =
  /<result>\s*<url>([\s\S]*?)<\/url>\s*<title>([\s\S]*?)<\/title>\s*<text>([\s\S]*?)<\/text>\s*<\/result>/gu;

/**
 * The message a failed lookup reports, to the model and to the reader alike.
 *
 * Exported so a test and a caller assert the same string rather than two copies of it, and
 * deliberately free of any detail about what actually went wrong: the model may quote it to the
 * user, and an upstream hostname or error code in a chat transcript informs nobody who can act on
 * it.
 */
export const DOCUMENTATION_SEARCH_UNAVAILABLE_MESSAGE =
  'Documentation search is currently unavailable.';

/**
 * Trims and truncates one result's body text.
 *
 * Trimming comes first because the upstream `<text>` blocks are indented and wrapped, so a length
 * check against the raw text would be measuring leading whitespace. The ellipsis replaces the final
 * character rather than being appended, so the result never exceeds the limit it was given — a
 * snippet whose length depends on whether it was truncated would make the cost of a prompt harder
 * to reason about than it needs to be.
 *
 * @param text Raw body text from one result block.
 * @param maxLength Longest permitted result, counting the ellipsis.
 * @returns The trimmed text, shortened with a trailing ellipsis when it was too long.
 */
function truncateSnippet(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

/**
 * Parses every result block out of one text content block.
 *
 * Deliberately tolerant. Text containing no well-formed block at all yields an empty array rather
 * than throwing, and that is this function's main job rather than an oversight: the upstream server
 * is free to answer a query it cannot serve with prose, and "the documentation had nothing for
 * that" is an answer the model can use, where an exception would be a failure it cannot distinguish
 * from the server being down.
 *
 * @param text One `text` content block's raw string.
 * @returns Every well-formed block found, in the order the server ranked them. Empty when there is
 *   none.
 */
function parseResultBlocks(text: string): DocumentationResult[] {
  const results: DocumentationResult[] = [];
  for (const [, url, title, body] of text.matchAll(RESULT_BLOCK_PATTERN)) {
    results.push({
      snippet: truncateSnippet(body, SNIPPET_MAX_LENGTH),
      title: title.trim(),
      url: url.trim()
    });
  }
  return results;
}

/**
 * Searches Cloudflare's documentation, throwing on failure.
 *
 * Opens a fresh client and transport, performs exactly one tool call, and closes the client again
 * in a `finally` so the connection is released on the failure paths as well as the happy one. Both
 * the handshake and the call share one `AbortSignal`, so the deadline bounds the whole operation
 * rather than each leg of it separately — two ten-second legs would be a twenty-second worst case,
 * which is not what the constant says.
 *
 * A response this function can parse no result out of is **not** a failure: it resolves to an empty
 * array. The distinction that matters to a caller is "the lookup happened and found nothing" versus
 * "the lookup did not happen", and only the second is an error.
 *
 * Most callers want {@link searchCloudflareDocumentationSafe} or {@link McpDocumentationSearch}
 * instead. This throwing form exists so each failure mode can be asserted on its own in a test, and
 * so the conversion to a non-fatal outcome happens in exactly one place.
 *
 * @param query Free-text query, as the model phrased it.
 * @returns Every result the server returned, normalised and truncated. Empty when it matched
 *   nothing or answered in a shape holding no result block.
 * @throws {Error} When the connection or the call exceeds {@link REQUEST_TIMEOUT_MS}, when the
 *   transport fails, or when the server reports a tool-level error. A `DOMException` named
 *   `TimeoutError` is the specific form the deadline takes; it is an `Error` subclass, so a caller
 *   catching `Error` catches it.
 */
export async function searchCloudflareDocumentation(query: string): Promise<DocumentationResult[]> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const transport = new StreamableHTTPClientTransport(new URL(DOCS_MCP_SERVER_URL));
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });

  try {
    await client.connect(transport, { signal });
    const result = await client.callTool(
      { arguments: { query }, name: DOCS_TOOL_NAME },
      { signal }
    );

    if (result.isError === true) {
      // The server distinguishes a transport failure from a tool that ran and failed. Both are
      // "the lookup did not happen" to a caller, so both arrive here as a throw rather than one
      // of them masquerading as an empty result set.
      throw new Error(`${DOCS_TOOL_NAME} reported a tool-level error for query "${query}".`);
    }

    const results: DocumentationResult[] = [];
    for (const block of result.content) {
      // Content blocks are a union: a server may return a resource link or an image beside the
      // text. Only text can contain result blocks, and anything else is skipped rather than
      // treated as malformed.
      if (block.type === 'text') {
        results.push(...parseResultBlocks(block.text));
      }
    }
    return results;
  } finally {
    await client.close();
  }
}

/**
 * Searches Cloudflare's documentation, reporting failure as a value.
 *
 * Catches every rejection {@link searchCloudflareDocumentation} can produce and reports
 * {@link DOCUMENTATION_SEARCH_UNAVAILABLE_MESSAGE} instead. The `catch` is deliberately
 * unqualified: there is no failure of a documentation lookup that should end a chat turn, so there
 * is nothing this function should let past.
 *
 * @param query Free-text query, as the model phrased it.
 * @returns `{ ok: true, results }` when the lookup completed — including when it matched nothing —
 *   and `{ ok: false, message }` when it did not.
 * @throws Nothing. That is the entire point of this function relative to the one it wraps.
 */
export async function searchCloudflareDocumentationSafe(
  query: string
): Promise<DocumentationSearchOutcome> {
  try {
    return { ok: true, results: await searchCloudflareDocumentation(query) };
  } catch {
    return { message: DOCUMENTATION_SEARCH_UNAVAILABLE_MESSAGE, ok: false };
  }
}

/**
 * MCP implementation of {@link DocumentationSearchPort}.
 *
 * One line, like `../durable-diagram-sessions.ts`'s methods and for the same reason: an adapter
 * that decided anything would be a second place the non-fatal contract could be got wrong. It
 * exists so the composition root can inject an object rather than a bare function, which is what
 * lets a chat turn be tested against an in-memory implementation with no mocking of a third-party
 * SDK at all.
 */
export class McpDocumentationSearch implements DocumentationSearchPort {
  /**
   * Searches the documentation and reports what was found.
   *
   * @param query Free-text query, as the model phrased it.
   * @returns The matching pages, or the non-fatal failure outcome.
   * @throws Nothing; see {@link searchCloudflareDocumentationSafe}.
   */
  async search(query: string): Promise<DocumentationSearchOutcome> {
    return await searchCloudflareDocumentationSafe(query);
  }
}
