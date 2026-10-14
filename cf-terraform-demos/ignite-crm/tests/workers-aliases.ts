/**
 * @file Module aliases that let Workers-only code be _imported_ by the Node and jsdom test
 *   projects. The Application Worker's Hono app is deliberately testable outside workerd: the unit
 *   suite runs it over the fake Data Worker, and the DOM suite serves the SPA's `fetch` from it.
 *   Since the chat feature, that app's import graph reaches the server-side Agents SDK, which
 *   imports `cloudflare:workers` — a module only workerd provides. Node's ESM loader rejects the
 *   scheme outright, so merely importing the route module would fail those suites. The aliases
 *   replace exactly the modules that cannot exist outside the runtime, and nothing else. What they
 *   substitute is never _executed_ by these suites: a chat connection is dispatched inside the
 *   Durable Object, and that path is covered by the Workers-runtime suite against the real runtime.
 *   A stub that throws when called would therefore be equivalent; a stub that silently succeeded
 *   would not, which is why `./agents-stub.ts` throws.
 */

import path from 'node:path';

/**
 * Directory holding the stub modules.
 */
const STUBS = path.resolve(import.meta.dirname, './unit');

/**
 * Aliases for a Vitest project that imports Worker code from Node or jsdom.
 */
export const workersAliases = [
  {
    find: /^cloudflare:(?:workers|test)$/u,
    replacement: path.resolve(STUBS, './cloudflare-workers-stub.ts')
  },
  {
    // Only the package root: `agents/mcp/server` is importable in Node, and aliasing it would hide
    // the MCP protocol behaviour the unit suite asserts against the real handler.
    find: /^agents$/u,
    replacement: path.resolve(STUBS, './agents-stub.ts')
  }
] as const;
