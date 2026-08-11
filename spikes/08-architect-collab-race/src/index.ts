/**
 * @file Placeholder Worker entry point.
 *
 * This spike never exposes an inbound HTTPS endpoint (see README.md's "Why this spike stays
 * entirely local" section) -- its only purpose is to give `@cloudflare/vitest-pool-workers` a
 * `main` module (and `TestDiagramSession` a `durable_objects` binding to be reachable through) so
 * it can boot the real `workerd` runtime `tests/*.test.ts` calls `TestDiagramSession`'s RPC
 * methods directly inside. Nothing here is deployed.
 */
export { TestDiagramSession } from "./diagram-session";

export default {
  async fetch() {
    return new Response(
      "This spike has no real HTTP surface; see tests/*.test.ts.",
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;
