# Cooperative Architect Drawing

Phase 1 establishes the secure deployment boundary for a cooperative architecture editor. The public landing and future anonymous share paths are protected by a hostname-wide Access bypass application. A more-specific Access application protects `/app*` and `/api/*`; the Worker independently validates that application's audience before serving the API.

The Worker and static Vue application deploy together. Static Assets provides SPA fallback while only `/api/*` and future `/shared/*` resolver traffic runs through Worker code. The local Vite Access plugin shares the same path policy and supplies two selectable identities, so the browser flow can be developed without a Cloudflare account.

Terraform owns the Worker registration, custom domain, Access resources, D1, R2, and KV. A bootstrap Worker deployment satisfies the custom-domain prerequisite; Wrangler owns later code deployments and bindings. The Worker explicitly depends on D1, R2, and KV so teardown deletes the Worker before bound resources. R2 is emptied before Terraform destroy.

The initial migration establishes D1 directory tables for diagrams, memberships, single-use invitation digests, publication metadata, and Workflow jobs. The `DiagramRoom` SQLite Durable Object and `ArchitectureWorkflow` are registered now but intentionally inert: later phases add document authority, WebSockets, and AI jobs without changing infrastructure ownership.

## Phase 2: Personal Diagram Library And Editor

Each diagram is two cooperating records: a D1 `diagrams` row (owner, title, timestamps) and a `DiagramRoom` Durable Object instance, addressed by `DIAGRAM_ROOM.getByName(diagramId)`, that owns the actual graph. D1 never stores the live graph — it is only the relational directory around the Durable Object's authoritative SQLite state, matching this demo's "distinct, easy-to-explain responsibilities" goal for each storage product.

Every edit — adding, moving, or deleting a node or edge, connecting two nodes, or applying a starter blueprint at creation — is sent as one revisioned operation: `{ operationId, baseRevision, kind, payload }`, posted to `POST /api/diagrams/:id/operations` and applied inside `DiagramRoom.applyOperation()` with `storage.transactionSync()`. The room deduplicates by `operationId`, rejects (and fully resyncs) a stale `baseRevision`, and validates the resulting document against a shared, renderer-independent graph schema (`src/graph/`) before ever persisting it. This is the same protocol Phase 4 reuses for real-time WebSocket collaboration and Phase 5 reuses for AI-proposal acceptance — Phase 2 exercises it with one editor so later phases add transport, not a new persistence model.

The editor itself is [Vue Flow](https://vueflow.dev/) (`src/client/components/diagrams/`): a searchable product palette, custom node/edge renderers for the curated Cloudflare product catalog and external actors, and a properties panel that edits a node's data through the same revisioned-operation store (`src/client/stores/diagram-document.ts`). `spikes/06-architect-vue-editor/REPORT.md` records why Vue Flow was selected and why ELK auto-layout is deliberately excluded from this bundle.

## Phase 3: Collaborator Invitations

A diagram's owner can grant another Cloudflare Access identity durable editor membership with one expiring link, without any organization-wide roles or an admin console — matching this demo's "a diagram has one owner and zero or more editors" access model.

An invitation is a bearer capability: `POST /api/diagrams/:id/invitations` generates 256 bits of randomness with `crypto.getRandomValues()`, base64url-encodes it into a 43-character raw token, and stores only its SHA-256 digest in D1's `diagram_invites.token_digest` (`src/worker/invitations/token.ts`, `src/worker/invitations/repository.ts`). The raw token is returned to the owner exactly once, in that response body, and is never logged, persisted elsewhere, or shown again — the invite dialog's "Copy link" action is the only place it ever exists in the browser, and only until the dialog is reopened. Redemption (`POST /api/invitations/redeem`) hashes the submitted token and looks it up by digest; a stolen digest is useless without the original 256-bit token, and a stolen token cannot be recovered from the digest.

Redemption's single-use guarantee comes from one atomic conditional `UPDATE`: `SET redeemed_at = ... WHERE token_digest = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`. At most one concurrent redemption can ever match that row, so there is no separate read-then-write step that a second, simultaneous redeemer could race. A non-matching update is resolved into an accurate RFC 9457 response — `404` for a digest D1 has never seen, `410 Gone` for one that is expired, revoked, or already redeemed — rather than a single generic failure.

Membership itself widens from Phase 2's owner-only `owner_email` check to a real `diagram_members` join (`DiagramRepository.getAccessible()`): any row with role `owner` or `editor` grants list/open/rename/edit access, while `DiagramRepository.requireOwner()` keeps invitation management and (Phase 6) publishing scoped to the owner alone. Both helpers preserve Phase 2's `404`-not-`403` rule for a caller with no membership row at all — an unauthorized probe cannot distinguish "no such diagram" from "not your diagram" — while `requireOwner()` correctly reports a confirmed editor's owner-only attempt as a `403`, since that identity's membership is already known.

The invitation redemption page lives at the protected `/app/invitations/:token` route — a sub-path of `/app`, already covered by the existing Access application and path policy — not at a public URL. This is a deliberately different mechanism from Phase 6's `/share#<token>` public fragment-token viewer: an invitation redeems into durable, authenticated `diagram_members` write access, while a share token only ever resolves an already-published, read-only R2 snapshot for an anonymous visitor. Confusing the two would let an anonymous link grant write access, or an authenticated capability leak into browser history and `Referer` headers — the invitation token is deliberately kept in a same-origin JSON body, never a URL path or query string.

## Further Reading

- [Vue Flow](https://vueflow.dev/)
- [Durable Objects storage API](https://developers.cloudflare.com/durable-objects/api/storage-api/)
- [Web Crypto API: `getRandomValues()`](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues)
- [Web Crypto API: `SubtleCrypto.digest()`](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)

- [Cloudflare Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/)
- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Workers Workflows](https://developers.cloudflare.com/workflows/)
- [D1](https://developers.cloudflare.com/d1/), [R2](https://developers.cloudflare.com/r2/), and [Workers KV](https://developers.cloudflare.com/kv/)
