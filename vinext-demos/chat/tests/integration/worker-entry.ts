/**
 * @file Entry module for the Workers-runtime suite. It is the test-side counterpart of
 *   `src/worker-entry.ts` and exists for exactly the same structural reason: a Durable Object
 *   namespace is bound to a _named class export on the Worker's entry module_, so whichever module
 *   the runtime is pointed at has to export `ChatRoom`. Production points at `src/worker-entry.ts`,
 *   which pairs the class with Vinext's App Router handler. These tests point here instead, pairing
 *   the same class with the standalone Hono application. That substitution is the whole difference,
 *   and it is deliberate: the API's authorization, validation, ordering, and authorship guarantees
 *   are framework-independent, so exercising them directly keeps the suite fast and free of a React
 *   build. The `app/api/**` handlers that forward into this application in production are thin
 *   enough to read in full — see `app/api/channels/[[...segments]]/route.ts`. Both halves of the
 *   real thing are therefore still real: the same Hono application, and the same `ChatRoom` class
 *   running on the same SQLite-backed Durable Object storage. Nothing here is a stand-in for
 *   application code.
 */

/**
 * The Hono chat application, as the default `fetch` handler.
 */
export { default } from '../../src/worker/index';

/**
 * The real `ChatRoom` class, backing the `CHAT_ROOM` namespace declared in `./vitest.config.ts`.
 */
export { ChatRoom } from '../../src/worker/infrastructure/chat-room';
