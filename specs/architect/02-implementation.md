# Architect — Phased Implementation Plan

## Delivery rules

- Implement `vinext-demos/architect` only according to
  [`01-specification.md`](./01-specification.md). The source implementation is behavioural prior
  art, not a source of repository conventions.
- Each phase is a shippable, passing repository state. Do not carry failing tests, temporary direct
  binding calls, unformatted files, or undocumented product gaps into the next phase.
- Use pnpm, `cf`, typed `cloudflare.config.ts`, Terraform, Oxfmt, Oxlint, the shared D1 migration
  helper, `@demos/worker-common`, and `@adrianhall/cloudflare-toolkit` from the first commit.
  Wrangler, per-demo `.env`, hand-written binding types, and generated deployment templates are
  prohibited.
- Re-confirm all moving surfaces — Vinext WebSocket handling, Cloudflare Access Managed OAuth,
  current Terraform provider schema, Agents/MCP packages, Durable Objects semantics, Workers AI
  model contract, and AI Gateway options — against current documentation before the phase that
  relies on them. Record the result in this demo's README/decision record, not only in a commit
  message.
- Every phase ends with `pnpm check` and `pnpm test`. Runtime integration projects use a finite
  timeout. Normal test suites stay offline; controlled real-account checks are manual, explicitly
  named, and never part of `test` or `check`.
- New or changed exports carry complete JSDoc as required by the repository root instructions.

## Cross-phase test and observability contract

Each feature adds tests at the lowest appropriate tier: pure domain/application tests, client DOM
tests, Worker routing/authorization tests, then Workers-runtime integration tests for binding and
socket behaviour. A test suite must assert negative security properties rather than merely omitting
them: raw token/prompt/email/graph data must **not** occur in logs or storage where prohibited.

Use request/diagram/operation IDs for structured logs. Log safe operation shape and error category,
not content. Provider/model failures must bind and log the original cause safely before returning a
sanitized problem response. Every feature that reaches a real provider additionally has one manual
deployed success-and-failure reality check before it is declared complete.

---

## Phase 1 — Foundation, infrastructure, and public shell

### Phase 1 Goal

Create the deployable Vinext application and prove the new repository lifecycle before porting
product behaviour.

### Phase 1 Deliverables

1. Create the pnpm workspace package with pinned Vinext/React, Cloudflare Vite plugin, `cf`, Hono,
   React Testing Library, Vitest, Terraform tooling, Oxfmt/Oxlint, worker-common, XYFlow, Zustand,
   ELK, fflate, and icon dependencies.
2. Create `cloudflare.config.ts`, typed `infra/outputs.ts`, committed `infra/local-outputs.json`,
   `.gitignore` entries for `.cloudflare/` and Terraform outputs/state, generated-type inclusion,
   and all required scripts.
3. Provision Worker registration/bootstrap deployment, custom domain, D1, KV, public/authenticated
   Access applications/policies, observability, and all scalar outputs. Add explicit Worker → D1/KV
   dependency edges. Do not add AI Gateway or Durable Objects yet.
4. Implement shared access policies, Access Vite plugin users, `createAccessMiddleware`, Hono
   error/logging setup, same-origin middleware, `GET /api/me`, operator `ADMIN_EMAIL` check, and
   upsert-on-auth user directory middleware.
5. Add Vinext public pages `/`, `/blueprints`, protected `/app`, `/app/admin`, dynamic editor/share
   placeholders, and app shell/header. Public assets (`/_next/*`) are explicitly bypassed.
6. Establish three Vitest projects: client jsdom, Worker node, and Workers runtime with D1
   migrations applied by `readD1Migrations()`/`applyD1Migrations()`.
7. Write the initial README: root prerequisites, command lifecycle, Access boundaries, no-secret
   policy, and planned feature layers.

### Phase 1 Tests

- Terraform/config output-name and binding contract; local D1 fixture uses the same database ID the
  migration command consumes.
- Access policy ordering, page redirect versus API non-redirect, public asset bypass, audience
  enforcement, development-token production guard, `/api/me` admin/non-admin cases.
- Client public/authenticated shells and keyboard-visible navigation.
- Workers-runtime unauthenticated/authenticated/wrong-audience outcomes and finite timeouts.

### Phase 1 Exit criteria

`pnpm start` opens a public landing page and challenges `/app`; `pnpm deploy` then `pnpm teardown`
works in the prescribed order; all required scripts and baseline checks pass.

---

## Phase 2 — Domain contracts, catalog, and D1 diagram directory

### Phase 2 Goal

Port reviewed static data and build the safe, owner-scoped diagram foundation before any canvas UI.

### Phase 2 Deliverables

1. Port catalog, official SVG icons, edge definitions, eight blueprints, and shared graph types into
   `src/shared/`; preserve stable product/blueprint/edge identifiers.
2. Add initial D1 migration for `diagrams` and `users`; implement D1 repository adapters and domain
   validators behind diagram repository ports.
3. Implement application use cases and thin routes for owned diagram list/create/read/metadata
   update/duplicate/delete. Add title/description limits, safe graph-shape validation, and
   non-enumerating owner checks.
4. Build dashboard card grid, creation dialog, blueprint gallery/preview, and dynamic
   `/app/diagrams/[id]` loading shell. Public gallery permits browse but requires authentication to
   create.
5. Implement client API modules and route-level error/status presentation. React Flow previews are
   non-focusable, `aria-hidden`, and pointer-inert.

### Phase 2 Tests

- Catalog uniqueness, valid blueprint references, and graph/edge validation including invalid
  endpoints and malformed persisted JSON.
- D1 repository owner isolation and duplicate/delete behaviour.
- Route authorization, same-origin/content-type rejection, no owner data in a foreign-id response.
- Dashboard creation, keyboard dialog use, card navigation, accessible relative/absolute times, and
  preview focus/pointer regression tests.

### Phase 2 Exit criteria

An authenticated user can create, list, open, rename, duplicate, and delete their own blueprint or
blank diagram, with reload persistence and no other identity able to discover it.

---

## Phase 3 — Single-user editor and accessibility baseline

### Phase 3 Goal

Deliver the useful core product: an accessible, autosaving Cloudflare diagram editor.

### Phase 3 Deliverables

1. Port the XYFlow canvas, typed nodes/edges, searchable palette, property panel, toolbar, local
   Zustand editor store, undo/redo, and debounced fallback graph autosave.
2. Lazy-load ELK on first auto-layout; retain a no-layout/failure state rather than loading it in
   the initial editor bundle.
3. Implement pointer drag _and_ palette click fallback for node creation; typed edge creation by
   drag and the native-select Connect nodes modal; edge/node properties and documentation links.
4. Implement responsive drawer behaviour for palette/properties, minimap toggle, visible canvas
   focus, status bar, real fit-to-view after nodes initialize, and reduced-motion edge animation.
5. Add reusable focus-trapped dialog/menu hooks, persistent palette collapse and dark/light/system
   theme preferences, and production-safe native `light-dark()` CSS configuration.

### Phase 3 Tests

- Store mutation/history and autosave debounce tests.
- DOM keyboard path to create a node and connect two nodes without a pointer; disabled/failure
  cases; labels for every icon-only control.
- Focus trapping, Escape/outside menu dismissal, focus restoration, contrast-token contract, drawer
  breakpoint semantics, `aria-hidden` thumbnail focus regression, reduced-motion rendering.
- Browser-level manual/probed fit-to-view and production CSS theme-override check; mocked XYFlow
  tests alone are insufficient for these layout properties.

### Phase 3 Exit criteria

One signed-in user can build, save, reopen, keyboard-edit, auto-layout, undo, and print a diagram
without accessibility regressions inherited from the prior implementation.

---

## Phase 4 — Digest-only sharing, moderation, and exports

### Phase 4 Goal

Complete the original single-user product layer.

### Phase 4 Deliverables

1. Add `diagram_shares` migration; D1 + KV sharing adapter; SHA-256-only token lifecycle; public
   resolver route and `/s/[token]` read-only page.
2. Add owner share controls that show a raw URL only on creation and support revocation. Keep
   `/api/shares/*` explicitly public in Access policy/order while all share-management calls remain
   authenticated owner routes.
3. Add administrator directory/moderation routes and UI; reuse the owner-blind safe projection for
   admin preview rather than exposing a broader diagram record.
4. Port PNG/SVG export, ZIP scaffold generation, print mode, and all theme polish. Verify generic
   scaffold output is documented as an artifact rather than this demo's deployment template.
5. Write `DEMO.md` and `EXPLAIN-DEMO.md` for core editor, sharing security trade-off, D1/KV roles,
   Access split, and admin design.

### Phase 4 Tests

- Token entropy/digest correctness; raw token absent from D1/KV/log fixtures; KV miss → D1 fallback
  and backfill; revocation and live-pointer update behaviour.
- Public anonymous share can read only the safe projection and cannot mutate; unknown/revoked share
  does not disclose diagram existence.
- Every non-admin receives 403 on every admin route; configured admin can moderate; deletion
  invalidates associated sharing state.
- Export filenames/scaffold ZIP contents, print side effects, production theme override, and
  readable/link semantics.

### Phase 4 Exit criteria

The core editor reaches feature parity: a user can safely share a live read-only diagram, export it,
use preferences/print, and an operator can moderate without any raw token or authorization leak.

---

## Phase 5 — MCP and Durable Object spike

### Phase 5 Goal

Resolve the moving platform constraints before adding a public agent surface.

### Phase 5 Deliverables

1. Use current Cloudflare documentation to prove the deployed `cf` Durable Object declaration,
   `DiagramSession` class export, Hibernation API, RPC/fetch distinction, and test-pool WebSocket
   behaviour. Reconcile the Vinext 101 workaround with current Vinext release behaviour.
2. Validate current Access Managed OAuth/DCR Terraform schema and one real OpenCode-compatible
   loopback authorization flow; do not change production account resources outside the controlled
   spike request.
3. Confirm current stateless MCP handler API and model-context SDK version; test a minimal protected
   endpoint through Hono/Access, not a duplicate auth stack.
4. Verify that workerd cannot use the browser's ELK bundle for server MCP auto-layout, or replace
   this assumption with a tested server-safe option. Record final choice.
5. Capture findings and update the README decision record before implementation begins.

### Phase 5 Exit criteria

The exact Managed OAuth, DO, MCP handler, test setup, and server-layout decisions are verified and
written down; no later implementation phase relies on source-repository assumptions alone.

---

## Phase 6 — Remote MCP server and one-way agent live sync

### Phase 6 Goal

Let an external agent read and change its owner's diagrams, with an open editor visibly updating.

### Phase 6 Deliverables

1. Add the Managed OAuth configuration and `/mcp*` authenticated destination to the existing Access
   application; add the shared policy with `redirect: false`.
2. Implement domain graph mutations and application MCP services; expose all specified MCP tools and
   resource. Reuse D1/share/export application ports in-process.
3. Add `DiagramSession` as a hibernatable, SQLite-class Durable Object that has no durable graph
   state. Implement owner-checked WebSocket upgrade and server-to-client `graph_updated` fan-out.
4. Implement the scrub-and-set verified identity header helper, attachment-pinned identity, and
   client WebSocket hook/toast. Forward the original upgrade request; never try to return a socket
   from RPC.
5. Re-export the class from `src/worker-entry.ts`; dispatch upgrades ahead of Vinext only by
   `Upgrade` header; plain requests still get `426` from normal routing.

### Phase 6 Tests

- MCP owner isolation, schema descriptions, safe export and share tool results.
- Unit and Workers-runtime tests that smuggled identity headers (including differently cased) are
  discarded, socket attachment survives hibernation, and non-upgrade receives 426.
- Connected editor sees a graph update from an MCP tool; raw graph/token is absent from logs.
- Deployed OAuth/MCP/manual editor live-sync reality check.

### Phase 6 Exit criteria

A signed-in MCP client can edit only its own diagram and an open owner editor tab updates promptly,
without a refresh or an unauthenticated Durable Object path.

---

## Phase 7 — Collaboration spike and collaborator model

### Phase 7 Goal

Establish the correctness argument for bidirectional multi-user editing and ship authorization/UI
for owner-managed collaborators.

### Phase 7 Deliverables

1. Re-confirm DO in-memory eviction, non-interleaving synchronous execution,
   `blockConcurrencyWhile`, and hibernatable multi-socket test behaviour. Create a controlled race
   proving the proposed write chain cannot let an older delayed persistence overwrite a newer graph.
2. Add the `diagram_collaborators` migration and D1 adapter. Implement `findAccessible()` while
   retaining owner-only methods for rename/delete/share/collaborator management.
3. Add list/add/remove/leave collaborator routes and shared-with-me list; use safe 404 behaviour for
   a never-seen email and non-members.
4. Add dashboard Shared with me section and a focus-managed Collaborators dialog that keeps
   anonymous share links visibly distinct from edit access.

### Phase 7 Tests

- Owner/editor/non-member authorization matrix across all affected routes.
- Owner cannot add self; an unknown-to-directory identity is safely rejected; idempotent add and
  editor self-removal work.
- Race spike asserts deterministic operation ordering and final D1 state, including deliberately
  slow first persistence.

### Phase 7 Exit criteria

An owner can grant and revoke edit access to a previously signed-in identity; that identity sees the
diagram in Shared with me but cannot perform owner-only operations.

---

## Phase 8 — Bidirectional operations, presence, and cursors

### Phase 8 Goal

Replace primary whole-graph editing with a shared, durable-object-serialized operation stream.

### Phase 8 Deliverables

1. Hydrate `DiagramSession` graph/sequence from D1 with `blockConcurrencyWhile()`; implement
   `applyOperation`, `applyWholeGraphReplace`, snapshot, and serialized fresh-graph write chain.
2. Define and use the shared discriminated WebSocket protocol. Every human, MCP, and HTTP fallback
   mutation reaches the same session port; `operation_rejected` is a user-recoverable result.
3. Update the client to send debounced granular operations while connected, reconcile self echoes,
   apply remote operations, and use whole-graph PUT only while a socket is unavailable.
4. Add ephemeral presence stack, remote cursor overlay, and remote selection highlight. Color is
   supplementary only; no presence/cursor data enters D1.
5. Update MCP graph tools to invoke `applyOperation(origin: 'agent')`; remove old one-way-only
   notification code.

### Phase 8 Tests

- Every operation kind, stale target rejection, cascade deletion, and type/edge validation.
- Two real runtime WebSocket clients plus an MCP-originated operation converge to exactly the same
  D1 graph and receive corresponding frames; simulated eviction rehydrates from D1.
- Presence join/leave/cursor/selection flow and explicit assertion that no persistence happens.
- Responsive and keyboard checks for presence UI/cursor labels.

### Phase 8 Exit criteria

Two collaborators see each other's node/edge edits, cursor, and selection live; agent changes are
visible to both; D1 remains the only durable graph source across session eviction.

---

## Phase 9 — AI gateway and assistant spike

### Phase 9 Goal

Resolve every external AI assumption before adding a billable, asynchronous feature.

### Phase 9 Deliverables

1. Use current Workers AI documentation and a bounded real-account test to select a tool-calling
   model and fallback, confirm plain-gateway support and exact streaming/tool-call wire shape.
2. Confirm Terraform provider fields for `cloudflare_ai_gateway`, provision a named gateway with
   explicit privacy/log/rate/cache/spend settings, and add the AI binding/gateway id in typed
   config.
3. Confirm public Cloudflare documentation MCP client package/API from a Worker-compatible
   environment, including timeout/close/error behaviour.
4. Re-confirm and directly test that work started in a DO WebSocket handler completes after the
   originating connection closes and later graph snapshot reflects it.
5. Record confirmed contracts and cost/privacy implications before building assistant UI.

### Phase 9 Exit criteria

There is written, tested evidence for model, gateway, docs MCP, and disconnect semantics; no AI UI
or direct `env.AI.run` call lands before this phase completes.

---

## Phase 10 — AI tools, chat engine, and session execution

### Phase 10 Goal

Make the assistant operate the same graph API as every other actor.

### Phase 10 Deliverables

1. Create pure catalog/graph prompt-context, grid-position, tool schema/dispatcher, and docs-client
   modules. The tool dispatcher produces existing graph operations or metadata commands; it does not
   access D1, sockets, or a Durable Object.
2. Implement the central gateway inference adapter and `runDiagramChatTurn()` with injected ports,
   bounded rounds, every-round tool definitions, streamed text/tool-call accumulation, recoverable
   malformed tool calls, source normalization, and safe log/event handling.
3. Extend `DiagramSession` for `chat_message`, per-connection ephemeral messages, status/token/tool
   result/done/error frames, `origin: 'ai-chat'`, and agent-change broadcast. Suppress the generic
   remote-update toast for the initiating socket only.
4. Add AI Gateway architecture guard: only its adapter calls `env.AI.run`; every invocation uses a
   non-empty gateway ID.

### Phase 10 Tests

- Prompt context includes exact current IDs and does not contain irrelevant graph payload fields.
- Tool validation/dispatch, docs-client success/timeout/malformed result, and no query/result
  logging.
- Fixture streamed model: tool round → shared mutation → final text; tool fragments, malformed JSON,
  round cap, rejected operation, reasoning-token suppression, and duplicate-bubble batching
  regression.
- Real DO integration: first socket chats, second socket receives applied AI operation, D1 persists;
  origin socket disconnect mid-turn and a later socket sees its completed graph.

### Phase 10 Exit criteria

A scripted AI turn safely changes D1 through `DiagramSession`, sources a documentation result, and
remains correct if its initiating tab disappears.

---

## Phase 11 — AI assistant UX and Generate with AI

### Phase 11 Goal

Expose the tested assistant through an accessible editor panel and public blueprint workflow.

### Phase 11 Deliverables

1. Build the shared right-side Details panel with Properties and AI Assistant tabs, expandable
   persistence, and a toolbar toggle. Selecting a node returns focus/context to Properties; palette
   collapse is a helpful one-time layout choice, not hidden state.
2. Add accessible transcript (`role=log` with measured announcements), composer, stop/cancel,
   streaming status, structured tool activity, source links, and failures without prompt disclosure.
3. Add Generate with AI tile/modal in `/blueprints`: after authentication create a blank diagram,
   use a short-lived existing live socket, allow refinement, then navigate to the saved editor.
4. Run client auto-layout once a generation completes; preserve user edits and ordinary undo/redo
   semantics for all assistant operations.
5. Update README, demo script, and explainer with AI model/gateway policy, cost controls, docs
   sources, ephemeral transcript policy, disconnect behaviour, and collaboration interaction.

### Phase 11 Tests

- Keyboard-only tabs/composer/dialog, focus restoration, transcript announcement behaviour, source
  link semantics, stop/error states, and no duplicated streamed message after batching.
- Scripted generate/refine/open flow; abandoned modal leaves a valid saved partial diagram, not an
  error or secret-bearing cleanup artifact.
- Two-user UI flow: one chats, one watches assistant operations arrive normally.

### Phase 11 Exit criteria

A presenter can generate a diagram from a description, refine it, open it, ask an in-editor
question/change, watch a collaborator receive it live, and inspect the corresponding AI Gateway
logs/cost in the dashboard.

---

## Phase 12 — Cloudflare product catalog reconciliation

### Phase 12 Goal

Reconcile Architect's product catalog, official icons, documentation links, blueprint references,
and generated-scaffold mapping against the **current** Cloudflare product set immediately before
release. Product names and availability change independently of the editor code: for example, K2 was
added and Pipelines was renamed **Basin Pipelines** during Cloudflare Birthday Week. The demo must
teach the current platform without breaking diagrams saved under an earlier catalog.

### Phase 12 Deliverables

1. Review the current Cloudflare product catalog, developer documentation, announcement/changelog
   material, and official icon source. Record the reviewed date and sources in the Architect
   decision record.
2. Classify every catalog difference explicitly as **add**, **rename**, **retire**, **merge**, or
   **no change**. Do not silently drop a prior product simply because its marketing name or product
   page changed.
3. Add current products that belong in an architecture diagram — including K2 when it remains a
   current Cloudflare product — with category, description, official icon where available, handles,
   documentation links, and scaffold metadata where a scaffold can honestly support it.
4. Rename products such as Pipelines to Basin Pipelines in their display label, description,
   documentation links, icon source, and blueprint/palette copy **without changing their stable
   `typeId`**. Existing diagram graph data stores `typeId`; preserving it makes every saved diagram
   render the new name immediately without a D1 migration or a graph rewrite.
5. For a genuinely retired or merged product, retain a compatibility catalog entry for every
   previously issued `typeId` unless a reviewed migration is explicitly designed. Mark it as legacy
   in the editor, link to its replacement/deprecation guidance, and ensure old diagrams continue to
   render and export. Never reuse its ID for a different product.
6. Reconcile the eight blueprints, AI prompt catalog context, MCP tool validation, generated
   scaffold mapping, tests, and documentation against the result. A new product is not selectable by
   an AI tool or a blueprint until its catalogue descriptor is complete and validated.

### Phase 12 Tests

- A compatibility fixture containing every historical `typeId` renders successfully, including
  renamed and retired entries; no saved node falls through to an unknown-product placeholder.
- A regression test asserts the former Pipelines ID is unchanged while its visible label is Basin
  Pipelines, and the same pattern is exercised for every future rename.
- Catalog uniqueness, official-icon resolution, current documentation URL validity where offline
  checking is possible, category/handle/scaffold descriptor validation, and blueprint references.
- AI/MCP schema tests prove the permitted product IDs are derived from the reconciled catalogue,
  rather than a stale hand-maintained tool enum.

### Phase 12 Exit criteria

The catalog reflects the reviewed current Cloudflare product set, K2 and Basin Pipelines are
represented appropriately, every rename retains its prior stable ID, and diagrams created before the
reconciliation render, edit, share, and export without data migration.

---

## Phase 13 — Final verification and presentation readiness

### Phase 13 Goal

Prove the full layered demo is safe, accessible, reproducible, and teachable.

### Phase 13 Deliverables

1. Close coverage gaps and run repository checks, production build, Terraform validation/format,
   generated binding freshness, and architecture/security guards.
2. Perform WCAG 2.2 AA and real-browser responsive/canvas review; run a production-built theme
   override test and a web performance review, addressing actionable regressions.
3. Execute manual deployed flows: public/Access boundaries; full core editor; digest-only share;
   admin moderation; Managed OAuth MCP edit; two-user collaborator operations/presence; AI
   generation and in-editor assistant; deliberate socket disconnect mid-AI turn; AI Gateway
   dashboard evidence.
4. Verify `pnpm deploy` followed by `pnpm teardown` deletes application code first and leaves all
   Terraform-owned resources and the cf-owned Durable Object namespace clean.
5. Finish README, `DEMO.md`, `EXPLAIN-DEMO.md`, and decision record with current versions/limits,
   explicit non-goals, prerequisites, and all trade-offs.

### Phase 13 Exit criteria

The full script is reproducible from a clean checkout with only root `.env`, every required check
passes, no security/accessibility regression from the inherited findings remains, and teardown
leaves the account clean.
