import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { DiagramService } from '../../src/worker/application/diagram-service.ts';
import { ShareService } from '../../src/worker/application/share-service.ts';
import type { AppBindings } from '../../src/worker/bindings.ts';
import { createMcpServerForRequest, singleTemplateVariable } from '../../src/worker/mcp/server.ts';
import type { McpToolContext } from '../../src/worker/mcp/tools.ts';
import {
  createMcpRouter,
  recordToolContext,
  requireToolContext
} from '../../src/worker/routes/mcp.ts';
import { FakeDiagramRepository } from './fake-diagram-repository.ts';
import { FakeDiagramSessions } from './fake-diagram-sessions.ts';
import { FakeShareRepository } from './fake-share-repository.ts';

/**
 * @file The seams either side of the MCP handler, unit-tested in plain Node. `./mcp-tools.test.ts`
 *   covers what each tool does and `../integration/mcp.test.ts` covers the protocol through real
 *   `workerd`; neither can reach the three fail-closed guards this file exists for. Each of them
 *   refuses to serve a request whose verified identity cannot be established, and each is
 *   unreachable through the mounted route by design — which is precisely why they need a test of
 *   their own rather than a comment claiming they work.
 */

/**
 * Identity the fixtures authenticate as.
 */
const ALICE = 'alice@example.com';

/**
 * Fictional origin: never a live deployment, so nothing here can reach an account resource.
 */
const ORIGIN = 'https://diagrams.test';

/**
 * Builds one request-scoped MCP tool context over in-memory ports.
 *
 * @param actorEmail Verified identity the context represents.
 * @returns A context equivalent to the one the route builds from a Hono context.
 */
function createToolContext(actorEmail: string = ALICE): McpToolContext {
  const shares = new FakeShareRepository();
  const diagrams = new DiagramService(
    new FakeDiagramRepository(),
    shares,
    new FakeDiagramSessions()
  );

  return {
    actorEmail,
    diagrams,
    logger: { info: () => undefined },
    requestUrl: `${ORIGIN}/mcp`,
    shares: new ShareService(shares, diagrams)
  };
}

describe('the per-request MCP tool context', () => {
  it('returns the context recorded for exactly that request object', () => {
    const request = new Request(`${ORIGIN}/mcp`, { method: 'POST' });
    const context = createToolContext();

    recordToolContext(request, context);

    expect(requireToolContext(request)).toBe(context);
  });

  // Keyed on the `Request` object itself rather than on any value inside it, so two callers
  // served concurrently by one isolate cannot be confused for each other even when their requests
  // are byte-identical — which, for two agents calling `tools/list`, they are.
  it('does not confuse two identical concurrent requests', () => {
    const first = new Request(`${ORIGIN}/mcp`, { method: 'POST' });
    const second = new Request(`${ORIGIN}/mcp`, { method: 'POST' });
    const alice = createToolContext(ALICE);
    const mallory = createToolContext('mallory@example.com');

    recordToolContext(first, alice);
    recordToolContext(second, mallory);

    expect(requireToolContext(first).actorEmail).toBe(ALICE);
    expect(requireToolContext(second).actorEmail).toBe('mallory@example.com');
  });

  // The fail-closed half. Reaching this would mean the handler had been invoked with a request the
  // router never saw, so there is no verified identity to scope the tools to. Serving the request
  // anyway is the only outcome worse than refusing it.
  it('refuses a request no router recorded, rather than guessing an identity', () => {
    const unrecorded = new Request(`${ORIGIN}/mcp`, { method: 'POST' });

    expect(() => requireToolContext(unrecorded)).toThrow(
      'No verified MCP tool context was recorded for this request.'
    );
  });
});

describe('the MCP server factory', () => {
  it('builds a server scoped to the request’s own verified caller', () => {
    const request = new Request(`${ORIGIN}/mcp`, { method: 'POST' });
    const context = createToolContext();
    const seen: Request[] = [];

    const server = createMcpServerForRequest({ requestInfo: request }, (received) => {
      seen.push(received);
      return context;
    });

    expect(seen).toEqual([request]);
    expect(server).toBeDefined();
  });

  // Unreachable through this Worker: the handler sets `requestInfo` on every HTTP invocation and
  // the Worker exposes no other transport. Asserted anyway because the guard is the hinge of the
  // identity design — a server built without a request is a server scoped to nobody — and an
  // untested guard is one a later refactor deletes as dead code.
  it('refuses to build a server with no request to scope it to', () => {
    expect(() => createMcpServerForRequest({}, () => createToolContext())).toThrow(
      'The MCP server factory was invoked without an HTTP request.'
    );
  });

  // The guard runs before the context is resolved, so a factory reached without a request never
  // calls into the application tier at all.
  it('does not resolve a tool context when there is no request', () => {
    let resolved = 0;

    expect(() =>
      createMcpServerForRequest({}, () => {
        resolved += 1;
        return createToolContext();
      })
    ).toThrow();
    expect(resolved).toBe(0);
  });
});

describe('the diagram resource template variable', () => {
  // `architect://diagrams/{id}` has no explode modifier, so the SDK's matcher yields a single
  // string or refuses the URI outright. These cases pin the normalization as a type obligation
  // rather than a behavioural branch — see `singleTemplateVariable`'s own documentation.
  it.each([
    ['a single value', 'abc', 'abc'],
    ['the first of a list', ['first', 'second'], 'first'],
    ['an empty list', [], ''],
    ['an absent variable', undefined, '']
  ])('reads %s', (_label, raw: string | string[] | undefined, expected) => {
    expect(singleTemplateVariable(raw)).toBe(expected);
  });
});

describe('the MCP route’s binding requirement', () => {
  /**
   * Mounts the real MCP router with a stub identity and an optional `PUBLIC_HOSTNAME`.
   *
   * The Access middleware is replaced by a stub rather than exercised: the Workers-runtime suite
   * already proves an unauthenticated caller never reaches this handler, and what matters here is
   * only what the handler does once it has an identity but no hostname.
   *
   * @param hostname Value to bind as `PUBLIC_HOSTNAME`, or `undefined` to leave it unbound.
   * @returns An app serving `POST /mcp`, plus the errors its handler threw. The errors are captured
   *   rather than inferred from a `500`, so a test can say _which_ guard refused.
   */
  function mount(hostname: string | undefined): { app: Hono<AppBindings>; thrown: Error[] } {
    const context = createToolContext();
    const app = new Hono<AppBindings>();
    const thrown: Error[] = [];

    app.use(async (honoContext, next) => {
      honoContext.env = { PUBLIC_HOSTNAME: hostname } as AppBindings['Bindings'];
      honoContext.set('Cloudflare_Access_Identity', {
        email: ALICE,
        source: 'header',
        sub: 'alice'
      } as never);
      honoContext.set('DIAGRAM_SERVICE', context.diagrams);
      honoContext.set('SHARE_SERVICE', context.shares);
      honoContext.set('LOGGER', { info: () => undefined } as never);
      await next();
    });
    app.route('/mcp', createMcpRouter());
    app.onError((error) => {
      thrown.push(error);
      return new Response(null, { status: 500 });
    });

    return { app, thrown };
  }

  // A misconfiguration rather than a request error, and it must say so. Without this guard the
  // handler's own `Host` allowlist would be built from `undefined` and every deployed tool call
  // would be refused with a `403` that reads like an Access failure — the most expensive possible
  // way to discover that Terraform's output was never written.
  it('refuses to serve when PUBLIC_HOSTNAME is not bound, naming the fix', async () => {
    const { app, thrown } = mount(undefined);

    const response = await app.request(`${ORIGIN}/mcp`, { method: 'POST' });
    // Consumed so the call does not stay in flight.
    await response.text();

    expect(response.status).toBe(500);
    expect(thrown[0]?.message).toContain('PUBLIC_HOSTNAME is not bound');
    // The message names the command that fixes it, because the symptom — every tool call
    // refused — says nothing about a missing Terraform output.
    expect(thrown[0]?.message).toContain('deploy:infra');
  });

  it('serves a request once the hostname is bound', async () => {
    const response = await mount('diagrams.test').app.request(`${ORIGIN}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }),
      headers: {
        'accept': 'application/json, text/event-stream',
        'content-type': 'application/json',
        'host': 'diagrams.test',
        'mcp-method': 'tools/list'
      },
      method: 'POST'
    });
    await response.text();

    expect(response.status).toBe(200);
  });

  // The handler is a module-scope singleton configured from the first request's binding, and
  // `allowedHostnames` is fixed at construction. A deployed Worker has one immutable binding set,
  // so a second hostname can only mean the module was reused across two configurations — and
  // silently keeping the first would make a DNS-rebinding defence depend on request order. This
  // test runs after the one above deliberately: the guard only exists once a handler has been
  // built, which is the whole situation it guards.
  it('refuses a second hostname rather than letting the allowlist depend on request order', async () => {
    const { app, thrown } = mount('other.test');

    const response = await app.request(`${ORIGIN}/mcp`, { method: 'POST' });
    await response.text();

    expect(response.status).toBe(500);
    expect(thrown[0]?.message).toContain(
      'PUBLIC_HOSTNAME changed after the MCP handler was configured.'
    );
  });
});
