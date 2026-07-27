# Decision Log

These decisions, gleaned from building `demos/url-shortener`, have been rolled
into `AGENTS.md` (Resource Ownership, Public Access, Source Organization,
Testing And Verification, and Observability And Security). Keep this log as
the historical rationale; update `AGENTS.md` first when a future demo reveals
the guidance below needs to change again.

## 1. wrangler.local.jsonc vs. wrangler.jsonc.tpl

There were problems with running vite with an alternate wrangler.jsonc, so the decision was made that wrangler.local.jsonc would be abandoned.  The approved way is to use a scripts/generate-local-wrangler.js and use that to generate a local version of wrangler.jsonc.  

Since local dev needs a separate environment, the .dev.vars overrides ENVIRONMENT (check this in if there are no secrets in it).  Also, package.json scripts was extensively modified for this new situation and to create the proper workflow.

## 2. vitest projects

We use vitest projects to organize tests.  Don't use playwright.  There is a vitest.config.ts for each type of test - integration in tests/integration, worker in src/worker and client in src/client.  Unit tests sit alongside the source file under test.  Integration tests for the API are separate.

We also added coverage with istanbul to the setup

## 3. Deployment of the worker

Since you can't connect the worker to a domain name until you have a worker deployment, we decided to allow an initial deployment of the worker which will then be overwritten by the wrangler deploy version.

## 4. Source organization

We organize source files for testability.  Do NOT put everything in one file.

## 5. Logging

Just use cloudflareLogger() - don't try to be fancy with log levels or anything like that.

## 6. R2 teardown uses the dashboard empty-bucket API

The R2 dashboard's observed `DELETE /client/v4/accounts/{account_id}/r2/buckets/{bucket_name}/objects?prefix=` request empties a bucket with the ordinary Cloudflare deployment token when it has `Workers R2 Storage - Edit`. The `spikes/empty-r2-bucket` validation confirmed the call deletes every object without S3 credentials or a Terraform-created account token.

For teardown, copy `demos/media-drop/scripts/empty-r2-bucket.js` into demos that need R2 cleanup and use it in preference to `@adrianhall/cloudflare-scripts`' `empty-r2-bucket` command. It reads the deployment token from the demo's `.env` and accepts the Terraform-derived bucket name. The endpoint remains undocumented, so this decision must be revisited if Cloudflare publishes, changes, or removes the API.

## NEW DECISIONS

New decisions will be located below here before they are incorporated, and moved above this heading when they have been incorporated.

## 7. Testing hibernatable WebSocket Durable Objects with `@cloudflare/vitest-pool-workers`

Building `demos/chat`'s `ChatRoom` integration tests (docs/04-ENTERPRISE-CHAT.md, Phase 3)
surfaced three distinct problems, each requiring a different fix. Do not treat WebSocket
integration test hangs as something to patch around with longer timeouts — find which of these
(or a new one) actually applies.

**Concurrent integration test files sharing one workerd runtime can starve WebSocket delivery.**
`@cloudflare/vitest-pool-workers` v0.13+ isolates *storage* per test file but can still run
multiple files' Workers concurrently against the pool. Two files each opening hibernatable
WebSockets against the same local runtime intermittently hung indefinitely in this environment,
even though each file passed in isolation. Cloudflare's own Vitest 4 migration guide already
documents the fix for suites that need to share state across files: pass
`--max-workers=1 --no-isolate`, or, in a project's own `vitest.config.ts`, set
`fileParallelism: false`. Set this on any integration project whose test files open real
WebSocket connections, not only ones that need shared storage.

**`ctx.storage.deleteAll()` deletes the schema, not just rows, and the instance may still be
live.** A Durable Object's `destroy()` RPC that calls `ctx.storage.deleteAll()` wipes the SQLite
tables themselves. Unless the instance is also evicted, it keeps running with no schema, and the
next request throws `no such table`. Do not rely on eviction to re-run the constructor and
recreate the schema — the timing is not guaranteed relative to the next request in a test (or in
production, immediately after a client reconnects). Instead, factor schema creation into a
private method the constructor and any storage-erasing RPC both call, so `destroy()` leaves the
object immediately usable again with a freshly initialized, empty store.

**Do not gate test completion on your own outbound WebSocket close handshake.** A test that calls
`clientSocket.close()` and awaits the resulting `"close"` event on that same client socket proved
unreliable in this pool, hanging even after the *server* side had already logged handling the
close. A server-*initiated* close (for example from a Durable Object's own `destroy()` calling
`ws.close(code, reason)`) reliably delivered its close event to the client in testing — only the
client-initiated round-trip was the problem. Do not depend on the client-initiated round-trip for
test correctness or cleanup. Use `evictAllDurableObjects({ webSockets: "close" })` (from
`cloudflare:test`) in `afterEach` as the one unconditional, documented mechanism guaranteeing no
socket outlives a test; call `socket.close()` best-effort without awaiting it.

**Prefer storage inspection over racing a WebSocket message against a timer.** A test asserting
something did *not* happen (routing isolation between two Durable Object instances, a rejected
message never being persisted) is more reliable checking `runInDurableObject`'s storage state
directly than opening a second socket and racing an expected non-event against a `setTimeout`.
The latter pattern is inherently racy and, in this project, correlated with the hangs above.

**Filter WebSocket test assertions by frame `type`, registered before the triggering action, not
by count or arrival order.** A hibernatable WebSocket server that broadcasts a presence update
immediately after replaying history (as `ChatRoom.fetch()` does) means a client's next frame
after "history" is not necessarily the frame under test. Register a `"message"` listener that
resolves only on a specific expected `type` and ignores everything else, always adding the
listener before performing the action expected to trigger that frame. This avoids both assuming
an exact frame count/order and the complexity of a general-purpose event queue.
