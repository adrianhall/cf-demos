import { Hono } from 'hono';
import { currentIdentityEmail } from '@demos/worker-common';
import type { AppBindings } from '../bindings.ts';
import { createArchitectMcpHandler, MCP_ROUTE } from '../mcp/server.ts';
import type { McpToolContext } from '../mcp/tools.ts';

/**
 * Per-request tool contexts, keyed by the very `Request` object the MCP handler is serving.
 *
 * This is how a caller's verified identity reaches a tool without ever being stored on the
 * module-scope handler. The route handler records the context it built from the Hono context, then
 * hands the same `Request` to the handler; the handler invokes its server factory once per request
 * with that request as `requestInfo`, and the factory reads the entry back out. A tool closure is
 * therefore scoped to exactly one caller, which is the property that makes a shared handler safe in
 * an isolate serving many of them.
 *
 * A `WeakMap` rather than a `Map` so an entry cannot outlive the request it describes even if a
 * response is abandoned mid-flight: there is no cleanup step to forget, and no way for a stale
 * identity to be found by a later request that happened to reuse an id.
 */
const contextsByRequest = new WeakMap<Request, McpToolContext>();

/**
 * Records the verified context for one request, immediately before it is handed to the handler.
 *
 * Paired with {@link requireToolContext} and named rather than inlined for the same reason
 * `withVerifiedIdentity` is a named function in `../infrastructure/session-protocol.ts`: the
 * recording and the lookup are two halves of one rule, and a rule split across two anonymous
 * expressions is a rule somebody edits half of.
 *
 * @param request The very `Request` object the handler will be given, which is also what it passes
 *   back to its server factory as `requestInfo`. Identity is keyed on that object rather than on
 *   any value inside it, so no two concurrent callers can collide.
 * @param context Verified per-request tool context to scope this request's tools to.
 */
export function recordToolContext(request: Request, context: McpToolContext): void {
  contextsByRequest.set(request, context);
}

/**
 * Reads back the verified context for one request, refusing to run without it.
 *
 * @param request The request the MCP handler is serving, as received by its server factory.
 * @returns The context {@link recordToolContext} recorded for that exact request.
 * @throws {Error} When no context was recorded. That means the handler was invoked with a request
 *   this router never saw, so there is no verified identity to scope the tools to — and building a
 *   server with a guessed identity is the only outcome worse than refusing. The MCP SDK turns the
 *   throw into a JSON-RPC error, so a caller is told the request failed rather than being served
 *   somebody else's diagrams.
 */
export function requireToolContext(request: Request): McpToolContext {
  const context = contextsByRequest.get(request);
  if (context === undefined) {
    throw new Error('No verified MCP tool context was recorded for this request.');
  }
  return context;
}

/**
 * The one module-scope stateless handler this isolate serves.
 *
 * `createMcpHandler` needs `allowedHostnames` when it is constructed, while a Worker binding is
 * available only from a request's Hono context — there is no module-scope `env`. The tiny lazy
 * initializer below bridges that runtime fact without returning to the obsolete handler-per-request
 * pattern: it constructs this singleton on the first request from `PUBLIC_HOSTNAME`, then every
 * later request reuses the same handler and receives its own server instance through the handler's
 * per-request factory. A deployed Worker has one immutable binding set, so a second hostname here
 * is a configuration error rather than a legitimate multi-tenant case.
 */
let handler: { fetch: (request: Request) => Promise<Response> } | undefined;

/**
 * Hostname the singleton handler was configured to validate.
 */
let configuredHostname: string | undefined;

/**
 * Returns the one module-scope handler, constructing it exactly once from the deployment hostname.
 *
 * @param hostname Public hostname this Worker serves, from the `PUBLIC_HOSTNAME` binding.
 * @returns The memoized stateless MCP handler.
 * @throws {Error} When a request in one isolate supplies a hostname different from the one that
 *   configured the handler. Bindings are immutable per deployment, so accepting that change would
 *   make the `Host` allowlist depend on request order.
 */
function handlerFor(hostname: string): { fetch: (request: Request) => Promise<Response> } {
  if (handler !== undefined) {
    if (configuredHostname !== hostname) {
      throw new Error('PUBLIC_HOSTNAME changed after the MCP handler was configured.');
    }
    return handler;
  }

  // This is the one `createMcpHandler` construction per Worker isolate. Its factory, not the
  // handler, runs per request and looks up the context keyed by that original Request.
  handler = createArchitectMcpHandler(hostname, requireToolContext);
  configuredHostname = hostname;

  return handler;
}

/**
 * The remote MCP endpoint, mounted at `/mcp`.
 *
 * Deliberately the thinnest router in this Worker. It resolves the verified identity, hands the
 * request to the MCP handler, and does nothing else: no authentication of its own, because the
 * Access middleware in `../index.ts` already covers `/mcp` through the shared policy list in
 * `src/access-policies.ts`; and no authorization of its own, because every tool reaches storage
 * through {@link DiagramService} or {@link ShareService}, which own the ownership rule for the HTTP
 * API too.
 *
 * The route literal must match `MCP_ROUTE` exactly. The handler performs its own route match and
 * answers `404` for any other pathname, so a mismatch here would surface as every tool call failing
 * for a reason the Worker's own logs would not explain.
 *
 * `POST` only, and that is the protocol rather than a restriction: the streamable HTTP transport
 * this endpoint serves carries every message as a POST, and the session `GET`/`DELETE` operations
 * belong to a stateful server this one deliberately is not. A `GET` therefore falls through to the
 * application's own `404`.
 *
 * @returns A Hono router serving the MCP endpoint.
 */
export function createMcpRouter(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  /**
   * Serves one MCP request as the verified caller.
   *
   * @param context Hono request context carrying the verified identity, the diagram and share
   *   services, the request-scoped logger and the `PUBLIC_HOSTNAME` binding.
   * @returns The MCP handler's response — a JSON-RPC result, an error object, or an SSE stream,
   *   depending on what the client asked for.
   * @throws {NullError} When mounted without the Access middleware in front of it, so no verified
   *   identity is available to scope the tools to.
   * @throws {Error} When `PUBLIC_HOSTNAME` is not bound, which would otherwise surface as every
   *   deployed tool call being refused by the handler's own `Host` check.
   */
  router.post('/', async (context) => {
    const hostname = context.env.PUBLIC_HOSTNAME;
    if (!hostname) {
      throw new Error(
        'PUBLIC_HOSTNAME is not bound. Run `pnpm deploy:infra` so Terraform publishes the '
          + 'hostname, or restore infra/local-outputs.json for local development.'
      );
    }

    const request = context.req.raw;
    recordToolContext(request, {
      actorEmail: currentIdentityEmail(context),
      diagrams: context.var.DIAGRAM_SERVICE,
      logger: context.var.LOGGER,
      // The share tools resolve their returned link against this, exactly as
      // `POST /api/diagrams/:id/share` resolves it against the request it is answering. An origin
      // belongs to the request rather than to the use case, so it travels with the context
      // instead of being read from a binding or written as a literal.
      requestUrl: context.req.url,
      shares: context.var.SHARE_SERVICE
    });

    return handlerFor(hostname).fetch(request);
  });

  return router;
}

export { MCP_ROUTE };
