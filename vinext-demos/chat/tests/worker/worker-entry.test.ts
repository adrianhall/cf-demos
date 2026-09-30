import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * @file Covers the one piece of routing this demo owns outside the framework: the entrypoint's
 *   decision to send a WebSocket upgrade to the API and everything else to Vinext. It is worth
 *   testing precisely because it is an exception to the family rules. The rule it bends — Vinext
 *   owns every path — is enforced here by assertion rather than by convention, so a later change
 *   that widened the exception (matching on a path, say, or forgetting to forward ordinary
 *   requests) fails the build instead of silently taking routing away from the framework. Both
 *   collaborators are mocked. The real behaviour of each is covered elsewhere: the Hono application
 *   by `tests/integration/`, and Vinext by the framework's own tests. What is under test here is
 *   only which of the two receives a given request.
 */

/**
 * Stand-in for the `101` an upgrade really produces.
 *
 * A literal `new Response(null, { status: 101 })` cannot be constructed here at all — the platform
 * refuses it with _"init["status"] must be in the range of 200 to 599"_. That restriction is the
 * very reason the entrypoint exists, so the test that documents it cannot also depend on
 * sidestepping it. Only the `webSocket` property distinguishes an upgrade response in practice, and
 * that is what the assertions below check for.
 */
const UPGRADE_RESPONSE = Object.assign(new Response(null, { status: 200 }), {
  webSocket: {} as WebSocket
});

const appRouterFetch = vi.fn(() => Promise.resolve(new Response('page', { status: 200 })));
const applicationFetch = vi.fn(() => Promise.resolve(UPGRADE_RESPONSE));

vi.mock('vinext/server/app-router-entry', () => ({
  default: { fetch: appRouterFetch }
}));

vi.mock('../../src/worker/index', () => ({
  default: { fetch: applicationFetch }
}));

// The Durable Object class is re-exported by the module under test and pulls in
// `cloudflare:workers`, which does not resolve outside the Workers runtime. The class itself is
// exercised for real in `tests/integration/chat-room.test.ts`.
vi.mock('../../src/worker/infrastructure/chat-room', () => ({
  // A named function rather than `class {}`: the assertion below only needs the export to exist
  // and be a constructible value, and an empty class is (rightly) rejected by lint as pointless.
  ChatRoom: function FakeChatRoom(): void {}
}));

const { default: entry, ChatRoom } = await import('../../src/worker-entry');

/**
 * Minimal bindings object. The entrypoint only forwards it, so its contents are irrelevant.
 */
const env = {} as Env;

/**
 * Minimal execution context, forwarded unchanged like the bindings.
 */
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

/**
 * Build a request to the socket route.
 *
 * @param headers Headers to send; an upgrade test supplies `Upgrade`.
 * @returns The request.
 */
function socketRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://chat.example/api/channels/general/socket', { headers });
}

describe('worker entrypoint', () => {
  // Both mocks are module-level, so call counts would otherwise accumulate across tests and an
  // assertion that something was called exactly once would pass or fail by test order.
  beforeEach(() => {
    appRouterFetch.mockClear();
    applicationFetch.mockClear();
  });

  it('exports the ChatRoom class the Durable Object namespace binds to', () => {
    // `exports.durableObject` in cloudflare.config.ts names this export; a deploy fails without
    // it, so the export existing is itself the contract.
    expect(ChatRoom).toBeDefined();
  });

  it('sends a WebSocket upgrade to the API, bypassing the Vinext router', async () => {
    const response = await entry.fetch(socketRequest({ Upgrade: 'websocket' }), env, ctx);

    expect(applicationFetch).toHaveBeenCalledOnce();
    expect(appRouterFetch).not.toHaveBeenCalled();
    // Returned by identity, not rebuilt. Rebuilding is exactly what Vinext's route-handler
    // pipeline does to every response, and it is what drops the socket.
    expect(response).toBe(UPGRADE_RESPONSE);
    expect(response.webSocket).not.toBeNull();
  });

  // Header names are case-insensitive, and a browser is free to send `upgrade`. Matching only the
  // capitalized spelling would route a real browser upgrade into the framework, where it fails.
  it.each(['Upgrade', 'upgrade', 'UPGRADE'])('recognizes the %s header', async (header) => {
    await entry.fetch(socketRequest({ [header]: 'WebSocket' }), env, ctx);

    expect(applicationFetch).toHaveBeenCalled();
    expect(appRouterFetch).not.toHaveBeenCalled();
  });

  // The exception is keyed on the protocol, not the path. A plain GET to the socket route must
  // still travel the ordinary Vinext route, so the API's own `426` is produced by the same route
  // table as every other response.
  it('sends a non-upgrade request to the socket route through Vinext', async () => {
    await entry.fetch(socketRequest(), env, ctx);

    expect(appRouterFetch).toHaveBeenCalledOnce();
    expect(applicationFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a page', 'https://chat.example/'],
    ['an API route', 'https://chat.example/api/channels'],
    ['a client chunk', 'https://chat.example/_next/static/chunk.js']
  ])('sends %s through Vinext', async (_label, url) => {
    await entry.fetch(new Request(url), env, ctx);

    expect(appRouterFetch).toHaveBeenCalledOnce();
    expect(applicationFetch).not.toHaveBeenCalled();
  });

  it('forwards the bindings and execution context unchanged', async () => {
    const request = socketRequest({ Upgrade: 'websocket' });

    await entry.fetch(request, env, ctx);

    expect(applicationFetch).toHaveBeenCalledWith(request, env, ctx);
  });
});
