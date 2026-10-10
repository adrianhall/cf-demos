import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A mocked MCP transport double for `@modelcontextprotocol/client` -- per this phase's own
 * "Testing" note (docs/09D-ARCHITECT-AICHAT.md's Phase 22 section): "a mocked MCP transport
 * double for the docs client (success, timeout, malformed response) -- no real network call."
 * `vi.hoisted()` is required here because `vi.mock()`'s factory below is hoisted above every
 * other top-level statement in this file, including plain `const` declarations -- referencing an
 * un-hoisted variable from inside the factory would throw a "Cannot access before
 * initialization" error at module-evaluation time.
 */
const { connectMock, callToolMock, closeMock, clientCtor, transportCtor } =
  vi.hoisted(() => {
    const connectMock = vi.fn();
    const callToolMock = vi.fn();
    const closeMock = vi.fn();
    const clientCtor = vi.fn().mockImplementation(function MockClient() {
      return { callTool: callToolMock, close: closeMock, connect: connectMock };
    });
    const transportCtor = vi.fn();
    return { callToolMock, clientCtor, closeMock, connectMock, transportCtor };
  });

vi.mock("@modelcontextprotocol/client", () => ({
  Client: clientCtor,
  StreamableHTTPClientTransport: transportCtor,
}));

const {
  DOCUMENTATION_SEARCH_UNAVAILABLE_MESSAGE,
  searchCloudflareDocumentation,
  searchCloudflareDocumentationSafe,
} = await import("./docs-client");

/** One well-formed `<result>` block, matching the upstream docs server's own real text-content
 * format (confirmed live in `docs/DECISIONS.md` #35 and by a direct `curl` during this phase's
 * implementation). */
function resultBlock(url: string, title: string, text: string): string {
  return `<result>\n<url>${url}</url>\n<title>${title}</title>\n<text>\n${text}\n</text>\n</result>`;
}

beforeEach(() => {
  connectMock.mockReset().mockResolvedValue(undefined);
  callToolMock.mockReset();
  closeMock.mockReset().mockResolvedValue(undefined);
  clientCtor.mockClear();
  transportCtor.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("searchCloudflareDocumentation", () => {
  it("normalizes a successful upstream response into { title, url, snippet }[]", async () => {
    callToolMock.mockResolvedValue({
      content: [
        {
          text: [
            resultBlock(
              "https://developers.cloudflare.com/workers-ai/function-calling/",
              "Function calling",
              "Function calling enables people to take LLMs and use the model response to execute functions.",
            ),
            resultBlock(
              "https://developers.cloudflare.com/durable-objects/",
              "Durable Objects",
              "Stateful serverless objects with transactional storage.",
            ),
          ].join("\n"),
          type: "text",
        },
      ],
      isError: false,
    });

    const results = await searchCloudflareDocumentation(
      "Workers AI function calling",
    );

    expect(results).toEqual([
      {
        snippet:
          "Function calling enables people to take LLMs and use the model response to execute functions.",
        title: "Function calling",
        url: "https://developers.cloudflare.com/workers-ai/function-calling/",
      },
      {
        snippet: "Stateful serverless objects with transactional storage.",
        title: "Durable Objects",
        url: "https://developers.cloudflare.com/durable-objects/",
      },
    ]);
    expect(callToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: { query: "Workers AI function calling" },
        name: "search_cloudflare_documentation",
      }),
      expect.anything(),
    );
    // Opened fresh and closed again -- no persistent connection kept alive between calls.
    expect(clientCtor).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("truncates an overly long snippet", async () => {
    const longText = "x".repeat(1000);
    callToolMock.mockResolvedValue({
      content: [
        {
          text: resultBlock("https://example.com/", "Title", longText),
          type: "text",
        },
      ],
      isError: false,
    });

    const [result] = await searchCloudflareDocumentation("query");
    expect(result?.snippet.length).toBeLessThan(300);
    expect(result?.snippet.endsWith("…")).toBe(true);
  });

  it("resolves to an empty array for a response with no result blocks (malformed)", async () => {
    callToolMock.mockResolvedValue({
      content: [{ text: "Sorry, I don't understand.", type: "text" }],
      isError: false,
    });

    await expect(searchCloudflareDocumentation("query")).resolves.toEqual([]);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("ignores non-text content blocks (e.g. a resource_link) alongside a text block", async () => {
    callToolMock.mockResolvedValue({
      content: [
        { type: "resource_link", uri: "https://example.com/other" },
        {
          text: resultBlock("https://example.com/", "Title", "Snippet text."),
          type: "text",
        },
      ],
      isError: false,
    });

    await expect(searchCloudflareDocumentation("query")).resolves.toEqual([
      { snippet: "Snippet text.", title: "Title", url: "https://example.com/" },
    ]);
  });

  it("resolves to an empty array for a response with no content blocks at all (malformed)", async () => {
    callToolMock.mockResolvedValue({ content: [], isError: false });
    await expect(searchCloudflareDocumentation("query")).resolves.toEqual([]);
  });

  it("throws when the upstream tool reports a tool-level error", async () => {
    callToolMock.mockResolvedValue({
      content: [{ text: "boom", type: "text" }],
      isError: true,
    });

    await expect(searchCloudflareDocumentation("query")).rejects.toThrow();
    // Still closed even though the call reported an error.
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("throws (and still closes the client) when the connection times out", async () => {
    connectMock.mockRejectedValue(new Error("timed out"));

    await expect(searchCloudflareDocumentation("query")).rejects.toThrow(
      "timed out",
    );
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("throws (and still closes the client) when callTool rejects", async () => {
    callToolMock.mockRejectedValue(new Error("network error"));

    await expect(searchCloudflareDocumentation("query")).rejects.toThrow(
      "network error",
    );
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});

describe("searchCloudflareDocumentationSafe", () => {
  it("returns { ok: true, results } on success", async () => {
    callToolMock.mockResolvedValue({
      content: [
        {
          text: resultBlock("https://example.com/", "Title", "Snippet text."),
          type: "text",
        },
      ],
      isError: false,
    });

    const outcome = await searchCloudflareDocumentationSafe("query");
    expect(outcome).toEqual({
      ok: true,
      results: [
        {
          snippet: "Snippet text.",
          title: "Title",
          url: "https://example.com/",
        },
      ],
    });
  });

  it("returns the non-fatal fallback outcome on a timeout, never throwing", async () => {
    connectMock.mockRejectedValue(new Error("timed out"));

    const outcome = await searchCloudflareDocumentationSafe("query");
    expect(outcome).toEqual({
      message: DOCUMENTATION_SEARCH_UNAVAILABLE_MESSAGE,
      ok: false,
    });
  });

  it("returns the non-fatal fallback outcome on a tool-level error, never throwing", async () => {
    callToolMock.mockResolvedValue({
      content: [{ text: "boom", type: "text" }],
      isError: true,
    });

    const outcome = await searchCloudflareDocumentationSafe("query");
    expect(outcome).toEqual({
      message: DOCUMENTATION_SEARCH_UNAVAILABLE_MESSAGE,
      ok: false,
    });
  });

  it("returns ok: true with an empty result set for a malformed (unparseable) response", async () => {
    callToolMock.mockResolvedValue({
      content: [{ text: "unexpected shape", type: "text" }],
      isError: false,
    });

    const outcome = await searchCloudflareDocumentationSafe("query");
    expect(outcome).toEqual({ ok: true, results: [] });
  });
});
