import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * @file Covers the documentation adapter against a double for `@modelcontextprotocol/client`. No
 *   real network call is made here, and none should ever be: a test that reached the live
 *   documentation server would fail offline, would be slow, and would assert the server's current
 *   content rather than this module's parsing of it. What is actually under test is the failure
 *   surface. The parsing is simple; the contract that matters is which outcomes throw and which do
 *   not, because the whole reason this module has two exports is that a chat turn must survive the
 *   ones that do.
 */

/**
 * The mocked SDK surface.
 *
 * `vi.hoisted()` is required rather than preferred: `vi.mock()`'s factory is hoisted above every
 * other top-level statement in the file, so a plain `const` referenced from inside it would be read
 * before it was initialised.
 *
 * Both constructors are `function` expressions rather than arrows, because the adapter reaches them
 * through `new` and an arrow has no `[[Construct]]`.
 */
const { callToolMock, clientConstructor, closeMock, connectMock, transportConstructor } =
  vi.hoisted(() => {
    const connect = vi.fn();
    const callTool = vi.fn();
    const close = vi.fn();
    return {
      callToolMock: callTool,
      clientConstructor: vi.fn(function MockClient() {
        return { callTool, close, connect };
      }),
      closeMock: close,
      connectMock: connect,
      transportConstructor: vi.fn(function MockTransport() {
        return {};
      })
    };
  });

vi.mock('@modelcontextprotocol/client', () => ({
  Client: clientConstructor,
  StreamableHTTPClientTransport: transportConstructor
}));

const {
  DOCUMENTATION_SEARCH_UNAVAILABLE_MESSAGE,
  McpDocumentationSearch,
  searchCloudflareDocumentation,
  searchCloudflareDocumentationSafe
} = await import('../../src/worker/infrastructure/ai/docs-client.ts');

/**
 * Builds one well-formed result block in the server's real text format.
 *
 * @param url Page URL to embed.
 * @param title Page title to embed.
 * @param text Body text to embed.
 * @returns The block, with the whitespace the real server emits between its tags.
 */
function resultBlock(url: string, title: string, text: string): string {
  return `<result>\n<url>${url}</url>\n<title>${title}</title>\n<text>\n${text}\n</text>\n</result>`;
}

/**
 * Makes the next tool call resolve with one text content block.
 *
 * @param text The text content the server should appear to return.
 */
function respondWithText(text: string): void {
  callToolMock.mockResolvedValue({ content: [{ text, type: 'text' }], isError: false });
}

beforeEach(() => {
  connectMock.mockReset().mockResolvedValue(undefined);
  callToolMock.mockReset();
  closeMock.mockReset().mockResolvedValue(undefined);
  clientConstructor.mockClear();
  transportConstructor.mockClear();
});

describe('searchCloudflareDocumentation', () => {
  it('normalises concatenated result blocks into { title, url, snippet }', () => {
    // Concatenated with no separator, which is exactly how the real server returns them.
    respondWithText(
      resultBlock(
        'https://developers.cloudflare.com/workers-ai/function-calling/',
        'Function calling',
        'Function calling lets a model call a tool and use the result.'
      )
        + resultBlock(
          'https://developers.cloudflare.com/durable-objects/',
          'Durable Objects',
          'Stateful serverless objects with transactional storage.'
        )
    );

    return expect(searchCloudflareDocumentation('function calling')).resolves.toEqual([
      {
        snippet: 'Function calling lets a model call a tool and use the result.',
        title: 'Function calling',
        url: 'https://developers.cloudflare.com/workers-ai/function-calling/'
      },
      {
        snippet: 'Stateful serverless objects with transactional storage.',
        title: 'Durable Objects',
        url: 'https://developers.cloudflare.com/durable-objects/'
      }
    ]);
  });

  it('calls the documentation tool with the query, once, over a fresh connection', async () => {
    respondWithText(resultBlock('https://example.invalid/', 'Title', 'Body.'));

    await searchCloudflareDocumentation('workers ai');

    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(callToolMock).toHaveBeenCalledWith(
      { arguments: { query: 'workers ai' }, name: 'search_cloudflare_documentation' },
      expect.anything()
    );
    // Opened fresh and closed again: no connection is kept alive between calls.
    expect(clientConstructor).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('bounds the handshake and the call with one shared deadline', async () => {
    respondWithText(resultBlock('https://example.invalid/', 'Title', 'Body.'));

    await searchCloudflareDocumentation('workers ai');

    const connectSignal = connectMock.mock.calls[0][1].signal as AbortSignal;
    const callSignal = callToolMock.mock.calls[0][1].signal as AbortSignal;

    // One signal rather than two: two ten-second legs would be a twenty-second worst case, and
    // an un-deadlined outbound call can hold a Durable Object alive and billed for minutes.
    expect(connectSignal).toBeInstanceOf(AbortSignal);
    expect(callSignal).toBe(connectSignal);
  });

  it('truncates an over-long snippet with an ellipsis', async () => {
    respondWithText(resultBlock('https://example.invalid/', 'Title', 'x'.repeat(1000)));

    const [result] = await searchCloudflareDocumentation('query');

    expect(result.snippet).toHaveLength(280);
    expect(result.snippet.endsWith('…')).toBe(true);
  });

  it('resolves to an empty array when the response holds no result block', async () => {
    respondWithText('Sorry, I have nothing for that.');

    await expect(searchCloudflareDocumentation('query')).resolves.toEqual([]);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('resolves to an empty array when the response holds no content at all', async () => {
    callToolMock.mockResolvedValue({ content: [], isError: false });

    await expect(searchCloudflareDocumentation('query')).resolves.toEqual([]);
  });

  it('skips a non-text content block beside a text one', async () => {
    callToolMock.mockResolvedValue({
      content: [
        { type: 'resource_link', uri: 'https://example.invalid/other' },
        { text: resultBlock('https://example.invalid/', 'Title', 'Body.'), type: 'text' }
      ],
      isError: false
    });

    await expect(searchCloudflareDocumentation('query')).resolves.toEqual([
      { snippet: 'Body.', title: 'Title', url: 'https://example.invalid/' }
    ]);
  });

  it('throws when the server reports a tool-level error, and still closes', async () => {
    callToolMock.mockResolvedValue({ content: [{ text: 'boom', type: 'text' }], isError: true });

    await expect(searchCloudflareDocumentation('query')).rejects.toThrow('tool-level error');
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the handshake times out, and still closes', async () => {
    connectMock.mockRejectedValue(new Error('The operation was aborted due to timeout'));

    await expect(searchCloudflareDocumentation('query')).rejects.toThrow('timeout');
    // The `finally` matters: a connection left open on the failure path is the one a retry
    // inherits.
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the call itself fails, and still closes', async () => {
    callToolMock.mockRejectedValue(new Error('network error'));

    await expect(searchCloudflareDocumentation('query')).rejects.toThrow('network error');
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});

describe('searchCloudflareDocumentationSafe', () => {
  it('reports a successful search as ok', async () => {
    respondWithText(resultBlock('https://example.invalid/', 'Title', 'Body.'));

    await expect(searchCloudflareDocumentationSafe('query')).resolves.toEqual({
      ok: true,
      results: [{ snippet: 'Body.', title: 'Title', url: 'https://example.invalid/' }]
    });
  });

  it('reports an empty result set as a success, not a failure', async () => {
    respondWithText('nothing matched');

    await expect(searchCloudflareDocumentationSafe('query')).resolves.toEqual({
      ok: true,
      results: []
    });
  });

  it('reports a timeout as the non-fatal outcome rather than throwing', async () => {
    connectMock.mockRejectedValue(new Error('The operation was aborted due to timeout'));

    await expect(searchCloudflareDocumentationSafe('query')).resolves.toEqual({
      message: DOCUMENTATION_SEARCH_UNAVAILABLE_MESSAGE,
      ok: false
    });
  });

  it('reports a tool-level error as the non-fatal outcome rather than throwing', async () => {
    callToolMock.mockResolvedValue({ content: [{ text: 'boom', type: 'text' }], isError: true });

    await expect(searchCloudflareDocumentationSafe('query')).resolves.toEqual({
      message: DOCUMENTATION_SEARCH_UNAVAILABLE_MESSAGE,
      ok: false
    });
  });

  it('reports a transport failure as the non-fatal outcome rather than throwing', async () => {
    callToolMock.mockRejectedValue(new Error('network error'));

    await expect(searchCloudflareDocumentationSafe('query')).resolves.toEqual({
      message: DOCUMENTATION_SEARCH_UNAVAILABLE_MESSAGE,
      ok: false
    });
  });

  it('never leaks the underlying cause into the message a model may quote', async () => {
    callToolMock.mockRejectedValue(new Error('ECONNREFUSED docs.internal.example:8080'));

    const outcome = await searchCloudflareDocumentationSafe('query');

    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain('ECONNREFUSED');
  });
});

describe('McpDocumentationSearch', () => {
  it('implements the port over the safe wrapper', async () => {
    respondWithText(resultBlock('https://example.invalid/', 'Title', 'Body.'));

    await expect(new McpDocumentationSearch().search('query')).resolves.toEqual({
      ok: true,
      results: [{ snippet: 'Body.', title: 'Title', url: 'https://example.invalid/' }]
    });
  });

  it('reports a failure as the non-fatal port outcome rather than throwing', async () => {
    connectMock.mockRejectedValue(new Error('network error'));

    await expect(new McpDocumentationSearch().search('query')).resolves.toEqual({
      message: DOCUMENTATION_SEARCH_UNAVAILABLE_MESSAGE,
      ok: false
    });
  });
});
