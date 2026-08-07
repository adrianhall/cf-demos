# Cooperative Architect Drawing

Phase 1 establishes the secure deployment boundary for a cooperative architecture editor. The public landing and future anonymous share paths are protected by a hostname-wide Access bypass application. A more-specific Access application protects `/app*` and `/api/*`; the Worker independently validates that application's audience before serving the API.

The Worker and static Vue application deploy together. Static Assets provides SPA fallback while only `/api/*` and future `/shared/*` resolver traffic runs through Worker code. The local Vite Access plugin shares the same path policy and supplies two selectable identities, so the browser flow can be developed without a Cloudflare account.

Terraform owns the Worker registration, custom domain, Access resources, D1, R2, and KV. A bootstrap Worker deployment satisfies the custom-domain prerequisite; Wrangler owns later code deployments and bindings. The Worker explicitly depends on D1, R2, and KV so teardown deletes the Worker before bound resources. R2 is emptied before Terraform destroy.

The initial migration establishes D1 directory tables for diagrams, memberships, single-use invitation digests, publication metadata, and Workflow jobs. The `DiagramRoom` SQLite Durable Object and `ArchitectureWorkflow` are registered now but intentionally inert: later phases add document authority, WebSockets, and AI jobs without changing infrastructure ownership.

## Phase 2: Personal Diagram Library And Editor

Each diagram is two cooperating records: a D1 `diagrams` row (owner, title, timestamps) and a `DiagramRoom` Durable Object instance, addressed by `DIAGRAM_ROOM.getByName(diagramId)`, that owns the actual graph. D1 never stores the live graph — it is only the relational directory around the Durable Object's authoritative SQLite state, matching this demo's "distinct, easy-to-explain responsibilities" goal for each storage product.

Every edit — adding, moving, or deleting a node or edge, connecting two nodes, or applying a starter blueprint at creation — is sent as one revisioned operation: `{ operationId, baseRevision, kind, payload }`, posted to `POST /api/diagrams/:id/operations` and applied inside `DiagramRoom.applyOperation()` with `storage.transactionSync()`. The room deduplicates by `operationId`, rejects (and fully resyncs) a stale `baseRevision`, and validates the resulting document against a shared, renderer-independent graph schema (`src/graph/`) before ever persisting it. This is the same protocol Phase 4 reuses for real-time WebSocket collaboration and Phase 5 reuses for AI-proposal acceptance — Phase 2 exercises it with one editor so later phases add transport, not a new persistence model.

The editor itself is [Vue Flow](https://vueflow.dev/) (`src/client/components/diagrams/`): a searchable product palette, custom node/edge renderers for the curated Cloudflare product catalog and external actors, and a properties panel that edits a node's data through the same revisioned-operation store (`src/client/stores/diagram-document.ts`). `spikes/06-architect-vue-editor/REPORT.md` records why Vue Flow was selected and why ELK auto-layout is deliberately excluded from this bundle.

## Further Reading

- [Vue Flow](https://vueflow.dev/)
- [Durable Objects storage API](https://developers.cloudflare.com/durable-objects/api/storage-api/)

- [Cloudflare Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/)
- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Workers Workflows](https://developers.cloudflare.com/workflows/)
- [D1](https://developers.cloudflare.com/d1/), [R2](https://developers.cloudflare.com/r2/), and [Workers KV](https://developers.cloudflare.com/kv/)
