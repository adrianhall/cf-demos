/**
 * @file The two MCP-related pathnames, shared between the Worker that serves the endpoint, the
 *   browser page that explains how to connect to it, and the tests that pin both postures. They
 *   live in `src/` for the same reason `./graph-element-types.ts` does: both sides need the values
 *   and neither owns them. The Worker's own module cannot simply be imported by the client —
 *   `src/worker/mcp/server.ts` pulls in the MCP SDK and the `agents` runtime, which have no place
 *   in a browser bundle — and the view cannot be imported by the Node-based Worker test project,
 *   which has no JSX transform. A plain constants module is reachable from all three. The
 *   relationship between the two values is the reason they share a file: one must not be a prefix
 *   of the other. See {@link MCP_GUIDE_ROUTE}.
 */

/**
 * Pathname the remote MCP endpoint is served on.
 *
 * Four things must agree on this literal, and all four resolve it from here rather than restating
 * it: the MCP handler's own `route` option, which answers `404` for any other pathname; the Hono
 * mount in `src/worker/index.ts`; the `runWorkerFirst` entry in `cloudflare.config.ts`, without
 * which the request is served the application's HTML by the asset fallback; and the public guide
 * page, which resolves it against the deployment's own origin to show a reader the endpoint to
 * configure.
 *
 * Note that `src/access-policies.ts` and `infra/access.tf` deliberately guard a _prefix_ of this
 * path rather than this exact value, which is what makes {@link MCP_GUIDE_ROUTE}'s choice of path
 * load-bearing.
 */
export const MCP_ROUTE = '/mcp';

/**
 * Pathname the public MCP guide page is served on.
 *
 * **It must not begin with {@link MCP_ROUTE}, and that is a real constraint rather than a stylistic
 * one.** `infra/access.tf` lists `${local.hostname}/mcp*` as a destination of the authenticated
 * Access application, and a trailing `*` in an Access path matches a _partial segment_ —
 * Cloudflare's own documentation gives `example.com/foo*` covering `example.com/food`. A guide page
 * at `/mcp-guide` would therefore be covered by that destination and challenged for a login at the
 * edge.
 *
 * The failure would also be silent in the one place a developer would look for it. The Worker's
 * policy list uses `/^\/mcp(?:\/|$)/u`, which does **not** match `/mcp-guide`, so
 * `src/access-policies.ts` and the deployed Access application would disagree: every offline test
 * would pass, and only the deployment would redirect. The visible symptom would be the page that
 * explains how to sign in demanding that the reader sign in first.
 *
 * `/guides/` shares no prefix with any enumerated Access destination, so a request for it falls
 * through to the hostname-wide public bypass application — the same posture the landing page and
 * the blueprint gallery rely on.
 *
 * Pinned by `tests/worker/access-policies.test.ts` (the Worker's own policy list),
 * `tests/worker/lifecycle.test.ts` (the Terraform destination globs) and
 * `tests/integration/worker.test.ts` (the running Worker).
 */
export const MCP_GUIDE_ROUTE = '/guides/mcp';
