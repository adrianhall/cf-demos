# Spike 07: Collaborative Diagram Room

## Scope

This is a local-only probe. It has no Terraform, Cloudflare API calls, deployed
Worker, remote binding, or Access configuration. The Worker route is the only
component that injects the stand-in trusted identity headers forwarded to the
Durable Object. A client selects `alice` or `bob` with `X-Spike-Client`; the
Worker removes any incoming `X-Spike-Trusted-Email` and
`X-Spike-Trusted-Role`, then adds its own values.

## Versions

Resolved locally on 2026-08-07:

| Component | Version |
| --- | --- |
| Node | 26.7.0 |
| npm | 11.19.0 |
| TypeScript | 7.0.2 |
| Vitest | 4.1.10 |
| Wrangler | 4.115.0 |
| `@cloudflare/vitest-pool-workers` | 0.19.0 |
| Miniflare | 4.20260722.1 |
| workerd | 1.20260722.1 |
| `@cloudflare/workerd-darwin-arm64` | 1.20260722.1 |
| Compatibility date | 2026-07-29 |

The initially selected date `2026-08-07` was rejected by this resolved workerd,
which supports dates through `2026-07-29`. This spike uses the latter date.

## Source-Verified Findings

- The current declarative Durable Object lifecycle declaration is
  `exports.DiagramRoom = { type: "durable-object", storage: "sqlite" }` with a
  matching `durable_objects.bindings` entry. It replaces the legacy `migrations`
  array. Source: [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).
- `ctx.acceptWebSocket()` enables hibernatable WebSockets; an attachment written
  with `serializeAttachment()` is available after hibernation through
  `deserializeAttachment()`. Attachments are lost when the socket closes and are
  bounded to 16,384 bytes. Source: [Hibernatable WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
- The Vitest test API supports `evictAllDurableObjects({ webSockets: "hibernate" })`
  for hibernation and `{ webSockets: "close" }` for deterministic socket closure.
  Source: [Vitest test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/).
- The repository's `testing-durable-objects` guidance requires serial test files,
  best-effort client closes without awaiting their close events, and a final
  `evictAllDurableObjects({ webSockets: "close" })`. The suite implements that
  exact recipe.

## Locally Verified Findings

- `wrangler types` accepts the declarative `exports` configuration and produces
  `DIAGRAM_ROOM: DurableObjectNamespace<DiagramRoom>`.
- Two scripted clients connect through the actual Worker upgrade route in the
  Vitest workerd pool. A client-provided trusted-email header of
  `mallory@example.test` is discarded; Alice's cursor frame contains only the
  Worker-injected `alice@example.test` identity.
- Two `final_position` operations sent at base revision 0 result in one accepted
  revision 1 and one `resync` containing the complete revision-1 document.
- `storage.transactionSync()` atomically updates `document_state` and inserts the
  corresponding idempotency record. Raw SQL `BEGIN`, `COMMIT`, and `ROLLBACK`
  are rejected by this workerd; use the Durable Object transaction API instead.
- Retrying `move-a-once` after a socket close and reconnect returns
  `operation_accepted` with `duplicate: true`; the revision remains 1, the
  operation table has one row, and the original final position remains intact.
- Two transient cursor broadcasts are delivered but no cursor table or document
  field exists. Storage inspection after both broadcasts sees only one accepted
  operation and the final node position.
- `evictAllDurableObjects({ webSockets: "hibernate" })` preserves Alice's socket
  attachment. A later cursor frame is attributed to Alice. Reconnecting creates
  a new attachment from the Worker-injected headers, as expected after an actual
  socket close.
- The cleanup recipe completed between the two tests without a timeout: track
  every returned client socket, call `close()` only as best effort, clear the
  set, then await `evictAllDurableObjects({ webSockets: "close" })`. The suite
  uses `fileParallelism: false`; it does not call `ctx.abort()`, so graceful
  eviction is appropriate.

## Deployed Findings

None. This spike was intentionally not deployed and made no Cloudflare API,
Terraform, remote-binding, or `wrangler dev --remote` call.

## Protocol Decision

### Client to room

```json
{"type":"operation","operation":{"operationId":"uuid-or-client-key","baseRevision":0,"kind":"final_position","payload":{"nodeId":"a","x":20,"y":30}}}
{"type":"cursor","x":20,"y":30,"selection":"a"}
```

Only `final_position` is durable in this probe. `operationId` must be unique per
logical edit and `baseRevision` must equal the current revision. Cursor messages
are transient and limited to one broadcast per socket every 50 ms.

### Room to client

```json
{"type":"sync","document":{"revision":0,"nodes":[{"id":"a","x":0,"y":0},{"id":"b","x":200,"y":0}]}}
{"type":"operation_accepted","operationId":"move-a","revision":1,"duplicate":false,"document":{"revision":1,"nodes":[...]}}
{"type":"resync","revision":1,"document":{"revision":1,"nodes":[...]}}
{"type":"cursor","email":"alice@example.test","x":20,"y":30,"selection":"a"}
```

A stale operation receives only `resync` with the entire current document; it is
not merged or automatically retried. A duplicate operation receives
`operation_accepted` with `duplicate: true` and the originally accepted revision.

## SQLite Decision

```sql
CREATE TABLE document_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  document_json TEXT NOT NULL
);
CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  base_revision INTEGER NOT NULL,
  accepted_revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
```

`storage.transactionSync()` performs this single synchronous unit: look up
`operation_id`; read the singleton document; return a duplicate result if it
exists; return a full-document stale result if `base_revision` differs; otherwise
update the node/revision and insert the operation record. The transaction commits
before `operation_accepted` is broadcast. The local runtime explicitly rejects
manual SQL transaction statements.

## Close Codes

| Code | Reason |
| --- | --- |
| 4400 | Malformed or unsupported collaboration frame. |
| 4401 | A forwarded WebSocket has no trusted identity attachment. |

No normal close code is application-defined. Test cleanup uses ordinary best-effort
client closes followed by server-side closure through the test API.

## Commands And Results

| Command | Result |
| --- | --- |
| `npm install` | Installed 83 local packages; npm reported 4 dependency audit findings (3 moderate, 1 high). No audit remediation was applied because this disposable spike uses its pinned toolchain. |
| `npm run generate:types` | Passed; generated ignored `worker-configuration.d.ts` from `exports`. |
| `npm run check:types` | Passed. |
| `npm test` | Passed: 1 file, 2 tests. The two tests cover concurrent stale resync/cursors and hibernate/reconnect duplicate safety. |
| `npm ls --depth=0` and `npm ls @cloudflare/workerd-darwin-arm64 workerd` | Produced the exact versions in this report. |

Two failed exploratory runs were resolved and retained as findings: the unsupported
`2026-08-07` compatibility date failed startup, and manual SQL transaction control
failed at runtime. The final command results above are the authoritative result.

## Limitations

- Evidence comes from `@cloudflare/vitest-pool-workers` workerd, not a manually
  driven `wrangler dev` localhost server or a deployed Worker.
- The identity seam is deliberately a local stand-in, not Cloudflare Access or
  D1 membership authorization.
- The graph and operation grammar contain only two nodes and final-position
  edits. The production demo still needs complete graph validation, role checks,
  same-origin enforcement, and client reconnect/conflict UX.
