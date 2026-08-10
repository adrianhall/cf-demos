/**
 * @file Placeholder Worker entry point.
 *
 * This spike never exposes an inbound HTTPS endpoint (see README.md's "Why this spike stays
 * entirely local" section) — its only purpose is to give `@cloudflare/vitest-pool-workers` a
 * `main` module to boot the real `workerd` runtime that `tests/elkjs-layout.test.ts` then runs
 * `elkjs` inside. Nothing here is deployed.
 */
export default {
  async fetch() {
    return new Response("This spike has no real HTTP surface; see tests/elkjs-layout.test.ts.", {
      status: 404,
    });
  },
} satisfies ExportedHandler;
