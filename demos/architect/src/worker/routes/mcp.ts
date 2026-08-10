import { createMcpHandler } from "agents/mcp/server";
import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { createServer } from "../mcp/server";

/**
 * Remote MCP server, mounted at `POST /mcp` by `../index.ts` behind the same `accessMiddleware`/
 * `upsertUserMiddleware` pair every `/api/*` route uses (docs/09B-ARCHITECT-MCP.md's Access
 * Model) -- no MCP-specific authentication code lives here or anywhere else in this router.
 *
 * A fresh `createMcpHandler(...)` is built on every request rather than once at module scope.
 * This demo's identity source is the already-verified `Cloudflare_Access_Identity` Hono context
 * variable, not the MCP SDK's own OAuth plumbing (`getMcpAuthContext()`/`AuthInfo`/`ctx.props`):
 * Cloudflare Access's Managed OAuth resolves a client's bearer token into a
 * `Cf-Access-Jwt-Assertion` header *before* the request reaches this Worker, so `ctx.props` (the
 * mechanism `@cloudflare/workers-oauth-provider`-fronted MCP servers rely on for
 * `getMcpAuthContext()`) is never populated here, and is `readonly` on Cloudflare's own
 * `ExecutionContext` type besides -- there is no supported way to set it from inside this
 * Worker's own request handling. `createMcpHandler`'s only other per-request-varying identity
 * option, its static `authContext` handler-creation option, would freeze whichever identity
 * built the handler into every request that instance ever served if cached at module scope -- a
 * cross-tenant identity leak this demo cannot risk. Building the handler fresh per request from
 * `createServer()`'s closure over this request's own resolved `ownerEmail` (`../mcp/server.ts`)
 * is therefore the correct wiring for this demo's Access-native (not OAuth-provider-fronted)
 * architecture, not a shortcut -- see `docs/DECISIONS.md` for the fuller reasoning.
 */
export const mcpRouter = new Hono<AppBindings>();

mcpRouter.all("/", async (context) => {
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const logger = context.get("LOGGER");
  const handler = createMcpHandler(
    () =>
      createServer({
        db: context.env.DB,
        getDiagramSession: (diagramId) =>
          context.env.DIAGRAM_SESSIONS.getByName(diagramId),
        logger,
        ownerEmail,
        requestUrl: context.req.url,
        sharesKv: context.env.SHARES,
      }),
    // Every tool call here is a single request/response with no server-initiated push -- an SSE
    // stream would add nothing a plain JSON response doesn't already give a calling harness like
    // OpenCode, and is simpler for both a presenter's own manual `curl` and this Worker's own
    // integration tests to read directly.
    { responseMode: "json" },
  );
  // Hono types `executionCtx` with its own minimal local interface, distinct from (though
  // identical at runtime to) Cloudflare's global `ExecutionContext` type `createMcpHandler`
  // expects -- the object Hono hands back is the same raw `ExecutionContext` the Worker's own
  // `fetch()` entry point received, just narrower in Hono's own declared type.
  return handler(
    context.req.raw,
    context.env,
    context.executionCtx as ExecutionContext,
  );
});
