# Architect — Implementation Plan

## 1. Delivery rules

This plan implements the specification in [`01-specification.md`](./01-specification.md) and the
porting discipline in [`00-introduction.md`](./00-introduction.md). It is intentionally ordered so
that a working source UI is copied before any feature is reimplemented.

### 1.1 Rules for every phase

1. Read the matching source component, CSS, tests, and source-document section before changing its
   equivalent. Do not infer behaviour from a screenshot when source code exists.
2. Copy client data/CSS/components as a unit, then change only documented seam imports. Do not
   rewrite JSX or CSS into a locally preferred style.
3. For every defect or new requirement: add a failing behavioural test, run it to prove failure,
   implement, rerun to prove success, then commit one conventional commit for that issue.
4. Run `pnpm check` and `pnpm test` before closing each phase. Run the coverage gate when its
   affected files change.
5. Visually compare the running port with the surviving source deployment, `architect.cfapps.uk`, at
   desktop and narrow widths. Test keyboard navigation, appearance modes, modal focus, and React
   Flow interaction in a real browser; jsdom cannot validate geometry or CSS.
6. Never introduce Wrangler, npm, a demo-local `.env`, or a hand-written replacement for a
   `@demos/worker-common` concern.
7. Never hard-code the Worker name or hostname. Both are Terraform variables
   ([specification §1.3](./01-specification.md#13-naming-and-coexistence-with-the-source-deployment));
   the source deployment at `architect.cfapps.uk` must keep working throughout, so a stale literal
   in a script or test risks deleting or overwriting the reference implementation.
8. Record every intentional visual/behavioural deviation in the relevant phase's README/spec update.
   There should normally be none.

### 1.2 Phase numbering

Phases 1–9 deliver source parity and Phase 10 extends the blueprint gallery beyond it. The source
documents reserve Phases 11–15 for MCP, 16–20 for collaboration, and 21–26 for AI assistance;
preserve that numbering so plans and decisions can be cross-referenced without translation.

## 2. Phase 1 — Scaffold, lifecycle, and visual baseline

### Goal

Create `cf-terraform-demos/architect` as a locally working React/Vite/Cloudflare Worker project.
Before building any product feature, prove the port can render the original stylesheet locally and
can be provisioned and destroyed cleanly.

### Deliverables

1. Start from the `cf-terraform-demos` lifecycle conventions, not a copy of a Vue client.
2. Add pnpm workspace package metadata, strict TypeScript, React/Vite configuration,
   `@cloudflare/vite-plugin`, `@vitejs/plugin-react`, Hono, React Flow, Zustand, and the exact
   source client dependencies needed for the first layer. Pin pre-release versions deliberately.
3. Add `cloudflare.config.ts` using `defineWorker()`/`defineConfig()` and `requireTerraformOutputs`;
   set compatibility date, observability, preview/Workers Dev and typed bindings explicitly.
4. Add Terraform split by concern: `providers.tf`, `access.tf`, `architect.tf`, `outputs.tf`, plus
   committed `local-outputs.json`. Terraform owns D1, KV, Worker registration/bootstrap, custom
   hostname, and Access applications/policies; `cf` owns code upload.
5. Declare `worker_name` and `hostname` as Terraform variables, defaulting to `cf-architect` and
   `cf-architect.cfapps.uk`, and expose them as documented scalar outputs. Derive every Worker,
   hostname, DNS, and Access resource from them. Nothing downstream — config, scripts, tests, or
   docs — may restate either literal. This keeps the source deployment at `architect.cfapps.uk`
   untouched and makes the eventual cutover a two-variable change
   ([specification §1.3](./01-specification.md#13-naming-and-coexistence-with-the-source-deployment)).
6. Add root-helper D1 migration scripts and required lifecycle scripts. `start` runs local
   migrations then `cf dev --persist-to .cloudflare/state`; deploy writes ignored Terraform outputs,
   runs remote migration, builds, then `cf deploy --prebuilt`; teardown deletes the Worker first,
   resolving its name from Terraform output rather than a literal.
7. Add the React SPA entry point and exact source `App.tsx` path selector with temporary source-like
   view placeholders. Do not add a router.
8. Copy source `app.css` in full before styling placeholders. Copy necessary CSS imports (including
   React Flow), system font stack, tokens, resets and global rules unchanged.
9. Configure Oxfmt, type-aware Oxlint/tsgolint, three Vitest projects, Istanbul coverage, generated
   Worker types, and the built-stylesheet contract test.
10. Add the composition root and a health/minimal API route solely to demonstrate Worker build and
    RFC 9457 error handling.

### Tests

- Configuration/types generate locally using only committed local outputs.
- Local D1 migration applies and local Access emulation protects an example API route.
- Built CSS retains `light-dark()`, `#f6821f`, source font stack, and all required `--cf-*` tokens.
- Terraform validate/fmt-check and lifecycle-script ordering are covered by `pnpm check`.
- A naming contract check proves the Worker name and hostname resolve from Terraform output, and
  that neither `architect.cfapps.uk` nor a bare `architect` Worker name appears as a literal in
  configuration, scripts, or tests — the source deployment must be unreachable from this demo's
  lifecycle commands.
- Real-browser local review confirms global CSS, both themes, and responsive baseline render.

### Exit criteria

`pnpm start`, `pnpm check`, `pnpm test`, `pnpm deploy`, and `pnpm teardown` work against
`cf-architect.cfapps.uk` while `architect.cfapps.uk` continues to serve the source implementation
untouched. The local page visibly uses the source stylesheet; a missing CSS file or CSS-minifier
regression fails a test.

## 3. Phase 2 — Access, shell, and identity

### Goal

Provide the original landing page and common application chrome with production-equivalent Access
behaviour, without duplicating authentication logic.

### Deliverables

1. Port `access-policies.ts`, adapting it to the common policy builder. Define public bypass,
   authenticated `/app*`/API paths, explicit `redirect: false` for APIs, and future `/mcp*` place
   holders only where Access ownership permits.
2. Build Terraform Access resources: public bypass and authenticated applications, shared audience
   output, `ADMIN_EMAIL` Worker variable, and path-specific custom-hostname setup. Derive every
   application domain and destination from the `hostname` variable, so the port's Access policies
   can never attach to the source deployment's hostname.
3. Compose `createAccessMiddleware`, `currentIdentity`, `createMeRouter`, same-origin middleware,
   structured logging, RFC 9457 handlers, and an admin middleware based solely on `ADMIN_EMAIL`.
4. Port source `AppHeader`, `DarkModeToggle`, `useIdentity`, theme helpers, landing view and hero
   diagram. Keep source CSS and DOM structure; substitute only endpoint and import paths.
5. Add `GET /api/me`; authenticated requests update the user-directory service best-effort. The
   public header treats unauthenticated identity resolution as anonymous.
6. Port logout, public/authenticated navigation semantics, and exact header states.
7. Create initial migrations for `diagrams` and `users`, with source comments retained.

### Tests

- Anonymous/public paths work; `/app*` and protected APIs challenge/reject as appropriate.
- JWT audience and admin checks run in Workers runtime, including a non-admin `403`.
- Foreign/missing origins and wrong JSON content types fail state-changing requests.
- Header renders anonymous, signed-in, and admin states; theme cycles system/light/dark/system
  without a control-size change; source navigation links have the expected destination.
- Built CSS/test contracts confirm dark-mode override works after production build, not only dev.

### Exit criteria

A public visitor sees the source-faithful landing page; a signed-in visitor sees source-faithful
application chrome and can sign out. No route relies on a hand-rolled Access verifier.

## 4. Phase 3 — Domain, ports, D1 directory, and creation journey

### Goal

Build the first complete vertical slice: a signed-in user can create a blank or blueprint-backed
diagram from the source-faithful blueprint gallery and find it in their dashboard.

### Deliverables

1. Port shared graph types, catalogue, blueprints, graph validation, and official vendored icons.
   Split pure validation into `domain/` and expose constants needed by both client and Worker from
   an explicitly shared module.
2. Define diagram/user repository ports and D1 adapters. Add diagram application service methods for
   list, create, get, update metadata, duplicate, delete, and graph save; inject them through the
   composition root.
3. Port client API modules, dashboard grid/cards, previews, timestamp utilities, confirmation modal,
   and creation wiring.
4. Port the blueprint gallery and preview **before adapting it**: real React Flow thumbnails,
   All/Serverless/AI/Media filters, card activation, button-styled action, and permanent blank
   canvas card.
5. Port the source `CreateDiagramModal` as the single creation experience. Blueprint cards open it
   over `/blueprints`; title/description seed from the selected blueprint; blank canvas begins
   blank; cancel/close/Escape share one close path. Dashboard **Create diagram** links to
   `/blueprints`, not an out-of-context form.
6. Preserve source focus trap, focus restoration, modal target sizes, descriptive form labels, and
   non-focusable thumbnails.

### Tests

- Pure graph and metadata validation rejects malformed values and canonicalises valid graphs.
- Application-service owner isolation returns uniform non-enumerating `404`.
- Integration tests prove create/list/get/duplicate/delete only affect the actor's diagrams.
- Client tests cover every blueprint filter, thumbnail inertness, blank canvas persistence through
  filtering, modal title/description defaults, close/cancel equivalence, and dashboard navigation.
- Browser review checks the source's two-column creation modal, card actions, actual miniature
  diagrams, and mobile layout.

### Exit criteria

The complete blank/blueprint creation transaction occurs on `/blueprints`; its result appears in My
Diagrams. The presentation matches the source rather than a reconstructed approximation.

## 5. Phase 4 — Single-user editor

### Goal

Port the full editable architecture canvas with all source interaction and accessibility behaviour.

### Deliverables

1. Port the Zustand store and client graph API, retaining undo/redo, dirty state, selected entity,
   properties/palette preferences, loading/errors and debounced autosave semantics.
2. Port custom `CFNode`, `CFEdge`, edge/node registries, product icon component, service palette,
   details/properties panels, diagram canvas, toolbar and status bar.
3. Port drag/drop plus the catalogue's accessible click fallback. Port the source **Connect nodes**
   dialog and its pure connection/handle selection functions; do not rely on inaccessible React Flow
   handles for the only keyboard path.
4. Port browser-side ELK auto-layout behind a lazy `import()`. Maintain source separate state for
   its loading/error control. Do not use ELK in a Worker.
5. Implement application/API graph load/save routes and ensure the source autosave only writes
   validated graph data through the diagram service.
6. Preserve full-viewport CSS geometry, initial `fitView`, responsive side-drawer breakpoints,
   animation/reduced-motion handling, canvas focus indicator, headings and read-only-safe props.

### Tests

- Unit test store history, graph operations, connection validation, handle selection and
  preferences.
- Integration test graph persistence and owner isolation.
- Client tests cover palette search/collapse, keyboard connection dialog, panel behaviour,
  undo/redo, autosave error state and read-only controls.
- Manual browser tests cover drag/drop, node drag, pointer connection, keyboard connection, fit view
  for fresh blueprints, narrow layout, theme, and reduced motion.

### Exit criteria

A user can create, edit, autosave, reload, reopen, duplicate and delete a diagram with source
single-user parity. A keyboard-only user can create connections through the native-form dialog.

## 6. Phase 5 — Sharing

### Goal

Add secure anonymous, read-only live-pointer sharing without weakening owner isolation.

### Deliverables

1. Add `diagram_shares` migration, share repository port/D1 adapter and `SHARES` KV adapter.
2. Implement a domain digest function and application service for rotate/status/revoke/resolve.
   Generate tokens with Web Crypto; retain only SHA-256 hex digest in D1/KV.
3. Port source share controls and read-only share view. Show the raw URL exactly once after
   creation; status never reconstructs it. Preserve source read-only canvas and view landmarks.
4. Expose owner-only share routes and public resolver route with a limited projection. Ensure the
   resolver is excluded from authenticated Access destinations.
5. Log share creation/revocation without raw token, graph or email content.

### Tests

- Token plaintext is absent from D1, KV, logs and non-create responses.
- Valid anonymous share works; unknown, revoked, malformed and deleted targets yield indistinct
  404s; a share immediately reflects subsequent graph changes.
- Non-owners cannot create, inspect, revoke or resolve an owner's private diagram by guessing ids.
- Client tests cover creation copy UI, one-time disclosure, revoke, and read-only controls.

### Exit criteria

The owner can share a current diagram read-only; no token is retained in raw form anywhere.

## 7. Phase 6 — Administration, exports, print, and preferences

### Goal

Finish Layer 1 parity with all source end-user and operator functionality.

### Deliverables

1. Add admin/user repository ports and D1 adapters plus admin service: paginated user directory,
   diagram counts, diagram moderation delete and cascading share cleanup.
2. Port source admin components, including accessible table/cell relationships and diagram controls.
3. Port PNG/SVG export, DOM-free project-scaffold generator/ZIP, export menu, print control and all
   menu dismissal behaviour.
4. Port theme and palette preferences as guarded local-storage utilities, source print CSS and
   source `light-dark()` theme semantics.
5. Ensure toolbar/header behaviour reflects source decisions, notably no extra app-shell banner in
   the editor and no malformed/underlined chrome controls.

### Tests

- Every admin route rejects every non-`ADMIN_EMAIL` actor and allows the configured admin.
- Moderation delete removes a diagram and makes dependent share resolution fail.
- Unit tests cover export filenames, SVG/scaffold content, menu dismissal and preference fallback.
- Client tests cover print side effects, export controls, admin visibility, timestamps, card overlay
  clickability and focus paths.
- Browser review covers export/print trigger behaviour and all three theme modes in production.

### Exit criteria

Layer 1 reaches source parity: catalogue, blueprints, dashboard, editor, sharing, admin, export,
print, responsive design, theme, and documented accessibility corrections.

## 8. Phase 7 — Source bug regression audit and documentation

### Goal

Turn the source's accumulated operational knowledge into maintainable regression coverage and
release-quality documentation rather than a list that must be rediscovered.

### Deliverables

1. Audit Bugs 1–35 in `09-ARCHITECT.md` against the port. Assign each to a focused test, built-CSS
   contract, or manual-browser verification step; document why geometry-only items need browser
   verification.
2. Run an accessibility review against WCAG 2.2 AA, including modal focus, contrast, headings,
   keyboard canvas/connect routes, target sizes, motion and responsive reflow.
3. Run a web-performance review. Confirm ELK is absent from initial bundle and import only occurs on
   auto-layout use.
4. Write `README.md`, `DEMO.md`, and `EXPLAIN-DEMO.md`: prerequisites, local/deploy/teardown, public
   vs authenticated route model, source-port provenance, D1/KV trade-offs, no-raw-token rule, and
   all deliberate limitations.
5. Close coverage gaps to at least 80% across all authored source and verify complete JSDoc.

### Tests and exit criteria

`pnpm check`, `pnpm test`, `pnpm test:coverage`, `pnpm deploy`, live browser review and
`pnpm teardown` pass in sequence. The README explains every resource and a clean account remains
after teardown. Only then is Layer 1 considered complete.

## 9. Phase 8 — Catalogue video links

### Goal

Close the source's documented dead video-icon branch with genuine, current official resources.

### Deliverables and tests

1. Re-verify current official Cloudflare video URLs for selected catalogue products.
2. Add useful `{ icon: 'video', title, url }` entries beside document links.
3. Test the actual video icon rendering and link semantics.

### Exit criteria

At least one catalogue product exercises each supported documentation-link icon with a valid, useful
destination.

## 10. Phase 9 — Source parity checkpoint

### Goal

Do not begin platform-expanding work until a release review confirms the port is faithful in a real
browser and structurally compliant with the four-tier architecture.

### Exit criteria

- All Layer 1 acceptance conditions in the specification pass.
- No component was re-authored where source code was available without a documented reason.
- A route/service/adapter dependency review finds no upward dependency and no route-created
  repository.
- Source and port are compared at landing, blueprints/create modal, dashboard, editor, share, admin,
  theme and narrow viewport. This is the last review for which both deployments exist, so it is the
  one that must be thorough.

### Cutover

Only once the above is signed off, and as a deliberate separate change:

1. Decide the fate of the source deployment — release its hostname and destroy or retire its
   resources — so the name is free.
2. Change `worker_name` to `architect` and `hostname` to `architect.cfapps.uk`. No other source
   change should be required; if one is, a literal escaped
   [specification §1.3](./01-specification.md#13-naming-and-coexistence-with-the-source-deployment)
   and the naming contract test needs tightening.
3. Re-apply Terraform, re-deploy, and re-verify Access on both postures plus one authenticated round
   trip on the new hostname.
4. Update `README.md`, `DEMO.md`, and `EXPLAIN-DEMO.md` URLs.

Until step 1 is complete, treat `architect.cfapps.uk` as production belonging to someone else.

## 10a. Phase 10 — Reference-architecture blueprint expansion

### Goal

Grow the blueprint gallery from the source application's 8 templates to cover every Cloudflare
**Developer Platform** reference architecture, so the gallery teaches the published architecture
catalogue rather than an arbitrary sample of it.

This is **new scope, not a dropped port item.** The source application shipped 8 blueprints and the
port reproduced all 8 faithfully in Phase 3; nothing was lost in porting. The source's set simply
predates, and never tracked,
[Find by solution → Developer Platform](https://developers.cloudflare.com/reference-architecture/by-solution/#developer-platform),
which lists 18 diagrams across AI, Serverless and Storage. Four of those 18 were already
represented, so this phase adds the missing 14 and reaches 22 templates in total.

### Deliverables

1. Map the existing 8 templates against the 18 published diagrams before authoring anything. The
   four already covered are RAG (`ai-rag`), Fullstack Applications (`fullstack-app`), Programmable
   Platforms (`multi-tenant-saas`) and Serverless global APIs (`api-gateway`); they are not
   duplicated or re-authored. `event-driven`, `media-pipeline`, `bff` and `realtime-collab` remain
   as source-ported templates with no published counterpart.
2. Add 14 blueprints, each transcribed from its page's numbered request flow rather than invented:
   five AI (automatic captioning, composable AI, content-based asset creation, multi-vendor
   observability, BigQuery ingestion), four Serverless (optimized image delivery, A/B testing,
   serverless ETL, image content management) and five Storage (egress-free multi-cloud, on-demand
   migration, event notifications, user-generated content, control/data plane).
3. Introduce the **Storage** category. The gallery derives its filter pills from the template data,
   so the new pill must appear with no gallery change; verify that rather than assuming it.
4. Add an optional `referenceUrl` to `Blueprint` recording the canonical documentation page, and
   surface it in the create-diagram modal. It must not go on a gallery card: a card is a single
   activation target, so a link inside it would be a nested interactive element.
5. Use only the existing 42 catalogue products. This phase adds no catalogue entries; where a
   published diagram names a non-Cloudflare component, model it with the generic external actor
   nodes the catalogue already provides.
6. Update the blueprint count and category wording in `README.md`, `DEMO.md`, the specification's
   port inventory, and the introduction's layer description.

### Tests

- The template count, the category set including Storage, and one-template-per-reference-URL.
- Every `referenceUrl` is an absolute canonical reference-architecture URL, and every template
  without one is a deliberate source-ported exception.
- Existing structural invariants continue to cover the new templates: catalogue type resolution,
  intra-blueprint edge endpoints, canonical graph form, shared React Flow type keys, and unique
  node/edge ids.
- Client tests cover the reference link's presence, absence for blank canvas and for an unreferenced
  template, and its `noopener noreferrer` target semantics.
- The gallery's data-driven filter tests must cover the new category without modification.
- Browser review confirms the new thumbnails render as real diagrams at desktop and narrow widths.

### Exit criteria

The gallery offers 22 templates under All/Serverless/AI/Media/Storage, every Developer Platform
reference architecture is represented exactly once, and each transcribed template links back to the
page it models. `pnpm check`, `pnpm test` and the coverage gate pass.

## 11. Phases 11–15 — MCP and one-way agent live sync

These phases implement `09B-ARCHITECT-MCP.md` only after Phase 9.

The source document was written for a Wrangler-deployed demo. Every instruction it gives about
`wrangler.jsonc.tpl`, `durable_objects.bindings` and `new_sqlite_classes` migrations is void here
and is replaced by the `cf` equivalents recorded in
[`03-mcp-spike.md`](./03-mcp-spike.md#4-declaring-a-durable-object-under-cf). That report is the
authority for these phases wherever it and the source document disagree.

### Phase 11 — MCP/DO spike — **complete**

#### Goal

Re-confirm every fast-moving surface these phases depend on before writing production code, against
the versions this repository actually resolves rather than against the source document or its own
spike report.

#### Deliverables

1. [`03-mcp-spike.md`](./03-mcp-spike.md), answering the current stateless MCP mechanism and exact
   versions to pin; the Access Managed OAuth schema at the pinned provider; the `cf` Durable Object
   declaration that replaces Wrangler's migrations; whether `elkjs` runs in `workerd`; hibernatable
   WebSocket test support; and what Phases 12–15 must do differently.
2. `agents@0.27.0` and `@modelcontextprotocol/server@2.0.0` added to the demo's dependencies as
   exact pins, with `pnpm install` run from the repository root. `zod` was already present.

#### Tests

- `pnpm check`, `pnpm test` and the coverage gate pass with the dependencies installed.
- The built Worker bundle is unchanged, because nothing imports them yet — proved by the existing
  built-bundle contract test rather than asserted.
- A throwaway Workers-runtime probe established the `elkjs` result empirically and was deleted; a
  second throwaway probe established the SDK bundles for `workerd` and was deleted.

#### Exit criteria

Four findings change the later phases and are recorded rather than carried as folklore.
`@modelcontextprotocol/server` must be pinned to `2.0.0`, because `agents@0.27.0` peer-pins it
exactly and the newest published `2.3.1` is an unmet peer. The handler can be built once at module
scope, because its factory receives a per-request context — so the source demo's handler-per-request
workaround for cross-tenant identity leakage is no longer needed. The pinned Terraform provider has
moved to 5.27.0 within its `~> 5.22` constraint and still offers Dynamic Client Registration as the
only registration mechanism. And `elkjs` still fails in `workerd`, so Phase 13's grid fallback is
confirmed rather than contingent.

### Phase 12 — MCP read and metadata tools

#### Goal

Serve an authenticated, stateless MCP endpoint at `POST /mcp` offering the read and metadata half of
the tool catalogue, reusing the existing Access application and the existing diagram services.

#### Deliverables

1. Add `oauth_configuration` to `infra/access.tf`'s existing `app` application — no second
   application and no second policy. Enable dynamic client registration with loopback and localhost
   allowances, and pair a short access-token lifetime with a long grant session so Access
   re-evaluates policy on every silent refresh. `/mcp*` is already a destination on that resource.
2. Add `/mcp*` to `assets.runWorkerFirst` in `cloudflare.config.ts`. `/mcp` is not under the
   existing `/api/*`, so without its own entry every MCP request falls through to the
   single-page-application asset fallback and 404s. `src/access-policies.ts` already covers the
   path, so no authorization decision is added here.
3. Implement `src/worker/mcp/server.ts`: a server factory plus one module-scope `createMcpHandler`,
   with `route: '/mcp'` and `allowedHostnames` derived from the Terraform `hostname` output. Scope
   the caller's identity through the factory's request context, never through a module-scope value.
4. Mount it at `POST /mcp` in the composition root behind the existing Access middleware, and carve
   `/mcp` out of `enforceSameOriginJson` with a comment: that middleware rejects a request carrying
   neither `Origin` nor `Sec-Fetch-Site`, which is every non-browser MCP client, and its CSRF
   reasoning does not apply to a bearer-authenticated caller.
5. Implement `list_diagrams`, `get_diagram` (tool plus an `architect://diagrams/{id}` resource),
   `create_diagram`, `rename_diagram` and `delete_diagram` as thin wrappers over the existing
   diagram application service. Tools call services in-process; never an internal fetch.
6. Describe every input field with `.describe()`, and state each tool's ownership scoping in its own
   description so a calling model need not infer the security model from behaviour.
7. Extend the existing structured log events with `via: 'api' | 'mcp'`.

#### Tests

- An unauthenticated request to `/mcp` is rejected; a request authenticated as a different identity
  gets the same non-enumerating `404` every diagram route returns, never a `403`.
- The same-origin carve-out is asserted, so a later tightening of that middleware cannot silently
  break every tool call.
- Each tool's schema and ownership scoping, against a fixture D1.

#### Exit criteria

An MCP client can list, create, rename and delete a diagram against a locally running instance
authenticated with a development JWT. `terraform validate` and `terraform fmt -check` pass; the real
Managed OAuth round trip is Phase 15's manual check and no phase runs `terraform plan` against the
account.

### Phase 13 — Graph mutation tools and live sync

#### Goal

Let an agent change a diagram's graph and have an open editor tab update live, without adding a
second write path or a second durable copy of the graph.

#### Deliverables

1. Pure graph-mutation functions in the domain tier — add, update and remove for nodes and edges,
   with node removal cascading to its edges — unit-tested against fixture graphs with no D1, Worker
   or MCP involvement.
2. `autoLayout` as a deterministic grid placement, ordered by a breadth-first traversal from the
   graph's edges. `elkjs` does not run in `workerd`
   ([spike §5](./03-mcp-spike.md#5-elkjs-in-workerd--re-verified-and-it-still-fails)), and the
   `auto_layout_diagram` tool description must say plainly that it produces a simpler arrangement
   than the editor's own auto-layout button.
3. A `DiagramSession` Durable Object holding no durable graph of its own: D1 stays authoritative and
   the object is only a live fan-out point. Declare it in `cloudflare.config.ts` as
   `exports.durableObject({ storage: 'sqlite' })` plus a matching `bindings.durableObject`, which is
   what replaces Wrangler's `new_sqlite_classes` migration. Terraform owns nothing of the namespace.
4. `GET /api/diagrams/:id/live`, under the existing `/api/` prefix so Access and `runWorkerFirst`
   already cover it. The Worker verifies ownership before forwarding the upgrade, and scrubs any
   inbound copy of the identity header before setting the verified one, in a single named function.
5. Accept with `ctx.acceptWebSocket()`, pin the identity with `serializeAttachment()`, and answer a
   non-upgrade request with `426 Upgrade Required` via `upgradeRequired()`. Persist before
   broadcasting. Share one discriminated-union frame module between the object and the browser.
6. Client: open the socket on mount, close on unmount, replace the store's graph on a newer update,
   and show the "updated by an agent" toast so the canvas does not change without explanation.

#### Tests

- Pre-upgrade authorization, `426` handling, and a smuggled identity header ignored — at the unit
  level including a differently-cased spelling, and again in the Workers-runtime suite.
- Identity read from the socket attachment rather than any frame.
- Reconstruction after `evictAllDurableObjects({ webSockets: 'close' })`, the automated proxy for a
  hibernating session waking up.
- Two simulated connections to one diagram both receive the push from a single graph-mutating tool
  call.
- `tests/integration/vitest.config.ts` gains the namespace declaration, `fileParallelism: false` and
  a finite `hookTimeout` alongside its existing `testTimeout`
  ([spike §6](./03-mcp-spike.md#6-testing-hibernatable-websockets-in-this-repository)).

#### Exit criteria

A graph-mutating tool call reaches an open, connected socket within the same test run.

### Phase 14 — MCP share and data exports

#### Goal

Complete the tool catalogue with the sharing lifecycle and the two export formats that are pure data
transforms.

#### Deliverables

1. `create_share_link`, `get_share_status` and `revoke_share_link`, wrapping the existing share
   service exactly as the REST share routes do.
2. `export_diagram` in `json` and `scaffold` formats only, reusing the existing DOM-free scaffold
   generator. PNG and SVG stay browser-only: they depend on the live canvas, and exposing them as
   server tools would mean promising a capability this demo does not have.

#### Tests

- The raw share URL is disclosed exactly once, on creation, and never reconstructed by status.
- Both export formats' content, including the encoded scaffold.
- A revoked or nonexistent diagram behaves identically to the REST routes' `404` posture.

#### Exit criteria

An agent can create a share link and retrieve a project scaffold using only tool calls.

### Phase 15 — MCP verification — **complete**

#### Goal

Prove the whole surface end to end and document the behaviour a presenter and a reader need to
understand.

#### Deliverables

1. Coverage is **100% of statements, branches, functions and lines** across all three Vitest
   projects, up from 99.48/98.47/99.48/99.45. Every previously-uncovered branch was closed by a
   behavioural test rather than by an exemption, except one line in `formatRelativeDate` whose
   unreachability is now true rather than merely asserted — see below.
2. Formatting, linting, type checking, coverage, the production build, `terraform fmt -check` and
   `terraform validate` all pass. There is no Wrangler generation step; `cf workers types` runs
   inside `check:types`.
3. `README.md` documents `POST /mcp` and `GET /api/diagrams/:id/live`, the `DIAGRAM_SESSIONS`
   namespace and what it does and does not store, Managed OAuth as an operator-visible setting to
   confirm after a deploy, and the fact that no additional API-token permission is required.
   `DEMO.md` gains the side-by-side presenter section — editor and terminal on one screen, an agent
   adding nodes, the canvas updating live, then `via: "mcp"` beside `via: "api"` in Workers Logs —
   plus the share-link and scaffold beats. `EXPLAIN-DEMO.md` gains "A second transport, not a
   second application" and "Why a Durable Object here specifically", the latter stating why this
   case clears a bar the repository's default posture otherwise sets against one.
4. The last-write-wins boundary is recorded in `EXPLAIN-DEMO.md` as a designed scope boundary, with
   the three facts that make it acceptable (one identity, a repaint rather than data loss, and the
   client's staleness check) and an explicit statement of what fails the moment a second human
   edits — which is what Phases 16–20 exist to fix by extending `DiagramSession`.
5. `cf-terraform-demos/architect/MCP-VALIDATION.md` is the re-runnable operator runbook for the
   Managed OAuth round trip, covering the dashboard settings to confirm, connecting a real client,
   completing the browser login, calling one tool from every catalogue category, the `via` field in
   the logs, and the silent-refresh check. It records why `allow_any_on_loopback` is the only
   mechanism that can admit OpenCode's fixed `http://127.0.0.1:19876/mcp/oauth/callback` redirect:
   `allowed_uris` requires `https`.

#### Tests

- **Protocol conformance**: `tools/list` asserted against an independently written catalogue
  (rather than against the server's own output), a described object schema and non-trivial
  description on every tool, an over-the-wire `tools/call` round trip of all sixteen tools, the
  protocol's own `isError` channel distinguished from an HTTP status, an unknown tool, and the
  exact-route match including the sibling path that inherits neither the route nor the same-origin
  carve-out.
- **Authentication failures at `/mcp`**: no credential; a correctly signed token minted for a
  different Access application in the same team (the check that matters, because the team shares
  one JWKS); an expired token; the refusal arriving as an RFC 9457 problem document rather than a
  JSON-RPC error; and never a login redirect.
- **Absence of secret logging**: `tests/worker/mcp-logging.test.ts` drives the whole catalogue in
  one pass and asserts no raw share token, no graph content and no email address reaches either the
  structured logger or the console — plus the positive half, that every mutation *is* logged by
  diagram id with `via: 'mcp'`, without which the negative assertions could be satisfied by logging
  nothing.
- **Hibernation**: reconstruction after `evictAllDurableObjects({ webSockets: 'close' })`, storage
  proved empty, a socket closed mid-fan-out not aborting delivery to the rest, and `webSocketError`
  releasing a failed connection identically to a clean close.
- **Ownership across transports**: one named test asserting that the same non-owner, against the
  same diagram, receives the identical non-enumerating `404` from `GET /api/diagrams/:id` and from
  `get_diagram`; that every mutating tool refuses a non-owner and writes nothing; and that an owner
  supplied as a tool argument is ignored.

#### Exit criteria

`pnpm fix`, `pnpm check`, `pnpm test` and `pnpm test:coverage` all pass, at 100% on every metric.
The one manual step remains the deployed Managed OAuth round trip, which cannot be emulated locally
because it is an Access-edge feature; `MCP-VALIDATION.md` is the runbook and is not a substitute
for running it once against a real deployment.

### Phase 15a — Server-side SVG export

#### Goal

Let an authenticated agent produce a real diagram image and embed it in a Markdown document, without
a DOM, Browser Rendering binding or second representation of the graph. The image is a pure vector
transform from canonical `GraphData`, so it belongs in the domain tier beside the pure graph
mutations and every transport that renders a graph can produce the same architecture.

This is **deliberate new scope**, numbered 15a so it follows the MCP surface it extends without
colliding with the reserved 16–20 collaboration and 21–26 AI ranges. It consciously diverges from
`09B-ARCHITECT-MCP.md`'s Non-Goals. That document excluded “Raster (PNG/SVG) export” because the only
known image path rasterised the live React Flow canvas with `html-to-image`, and a Worker has no DOM.
That reasoning still excludes PNG and a pixel-faithful canvas capture. It does not exclude writing
vector markup directly from `GraphData`: no rasterisation or renderer is involved, so the premise
that made the original exclusion correct simply does not apply.

#### Deliverables

1. Add a pure `GraphData` → SVG domain transform with no binding, fetch, storage, DOM or runtime
   dependency. It computes a non-degenerate viewBox from actual node extents plus padding, including
   empty, single-node and disconnected graphs.
2. Draw labelled catalogue-coloured node shapes at stored positions and render edge colour,
   solid/dashed/dotted style, arrowheads and labels from the catalogue. The node shows both the
   user-controlled instance label and the catalogue product name, so the architecture stays legible
   without relying on an icon.
3. Do not embed the vendored official product glyphs. They are possible to inline, but a dynamic
   catalogue lookup would pull the entire roughly 140 KB icon set into the Worker bundle; an exported
   file also distributes Cloudflare brand marks outside the product UI. A category-coloured swatch
   plus the exact searchable product label carries the same architectural information with less
   output, no path/licensing ambiguity and better screen-reader text. Record that trade-off in the
   transform rather than leaving a missing icon unexplained.
4. XML-escape every user-controlled string before it enters text or an attribute: node label and
   description, edge label and diagram title. A label containing markup, ampersands and both quote
   forms must remain literal parsed text, never create an element.
5. Extend `export_diagram` with `format: "svg"`. Return the complete `image/svg+xml` document as an
   MCP text block, not base64 and not a resource blob; it is text and an agent needs to save it
   verbatim. Keep the existing owner-scoped service call and uniform non-enumerating `404`.
6. Rewrite the public `/guides/mcp` image examples as real working flows: export SVG, save it, and
   reference it from Markdown. Retain only the narrower accurate note that PNG remains browser-only.
   Update `README.md`, `EXPLAIN-DEMO.md`, `DEMO.md` and `MCP-VALIDATION.md` so none retains the stale
   “no image capability” claim.

#### Tests

- Parse generated output as `image/svg+xml` and assert its structure, namespace, title, positive
  viewBox, node/edge groups, styles and markers. Substring matching alone is not evidence that the
  bytes form a valid SVG document.
- Explicitly inject a node/edge/title string containing `<script>`, `&`, double quotes and single
  quotes; prove parsing succeeds, no `script` element exists and the parsed text remains literal.
- Cover empty, single, disconnected, negative-coordinate, malformed-but-canonical-storable and
  dangling-edge cases, plus horizontal/vertical straight and bent routes.
- Cover SVG through the plain tool function and over the real MCP handler, including text-block
  transport, schema enumeration, title/content and the same non-owner `404` as JSON/scaffold.
- Render a real multi-node blueprint in a real browser and compare it with the editor: the same nodes
  occupy recognisably the same arrangement, every connection reaches the right endpoints, labels
  are legible, and the computed viewBox clips nothing. Embed that file from Markdown and confirm the
  preview displays it.
- Measure the production Worker bundle against the existing 1,230,000-byte ceiling. Record the
  before/after bytes; if the transform exceeds the remaining measured allowance, raise the ceiling
  only with the same evidence and explanation Phase 14 required.

#### Exit criteria

`export_diagram(format: "svg")` returns valid, owner-scoped, standalone vector markup that an agent
can save and embed from Markdown; a real blueprint has been inspected in a browser beside the editor;
PNG remains accurately documented as browser-only; the Worker bundle contract still holds; and
`pnpm fix`, `pnpm check`, `pnpm test` and `pnpm test:coverage` pass at 100% statements, branches,
functions and lines.

#### Three defects found while closing the gaps

Each was a latent fault rather than a coverage inconvenience, which is the argument for closing
gaps with behavioural tests instead of exemptions.

1. **`formatRelativeDate` threw on an unparseable timestamp.** The fall-through after its unit loop
   was commented "unreachable", and was reachable: a `NaN` delta compares false against every rung
   and reached `Intl.RelativeTimeFormat.format(NaN)`, which throws a `RangeError`. Thrown from a
   render, one malformed `updated_at` would have blanked the whole dashboard. It now returns
   `'unknown'`, and the fall-through is genuinely unreachable.
2. **A test asserted the wrong thing under the right name.** `DetailsPanel`'s "treats an edge with
   no data at all as a data flow" passed `undefined` to a helper with a default parameter, so it
   exercised the ordinary case. The edge is now constructed without a `data` key.
3. **The keyboard and drop paths duplicated a catalogue guard.** `DiagramCanvas` had two
   independent "is this a product we know?" checks, one of them unreachable because the palette
   only renders the catalogue. They are now one `addCatalogueNode` helper, so the decision is taken
   once and both paths produce identically-shaped nodes by construction.

Three small refactors made guards testable without weakening them: `recordToolContext` /
`requireToolContext` name the two halves of the per-request identity rule in `routes/mcp.ts`,
`createMcpServerForRequest` exposes the factory's one fail-closed guard, and
`singleTemplateVariable` turns a resource-template cast into a function that can be proved correct.

## 12. Phases 16–20 — Collaboration

These phases implement `09C-COLLABORATIVE-EDITING.md`, extending the existing
`DiagramSession` rather than creating another per-diagram object. The source document was written
for a Wrangler deployment and a flatter Worker layout. Its Wrangler migration/configuration
instructions are void here; [`05-collaboration-spike.md`](./05-collaboration-spike.md) records the
current `cf` + Terraform and four-tier equivalents, and is the authority wherever it differs from
the source text.

### Phase 16 — Collaboration/DO spike — **complete**

#### Goal

Re-confirm the Durable Object lifecycle, input-gate, write-ordering, and multi-client test
behaviour that collaboration depends on before production code changes the existing one-way live
session into a bidirectional coordinator.

#### Deliverables

1. [`05-collaboration-spike.md`](./05-collaboration-spike.md), backed by current Cloudflare
   documentation and throwaway real-`workerd` probes, covering disposable class fields (including
   uncaught-exception loss), the exact synchronous/`await` input-gate boundary, same-node races,
   ordered persists, multi-client support, and response-body cleanup.
2. A concrete four-tier and `cf`/Terraform delta list for Phases 17–20, including the root D1
   migration helper, the next migration filename, and the change from the one-way
   `notifyGraphUpdated` seam to typed bidirectional session operations.
3. No production behaviour change and no retained probe code. The report, not a test-only second
   `DiagramSession`, is the durable result of this phase.

#### Tests

- Throwaway integration probes run against the configured `@cloudflare/vitest-plugin` real
  `workerd` project with two concurrent calls to one object, asserting two non-interleaved
  synchronous mutations and one deterministic final same-node winner.
- An adversarial slow-first/fast-second persist proves a deliberately unchained implementation
  final-clobbers the newer graph while the ordered chain converges correctly. The probe separately
  distinguishes fresh-at-link-start reads from enqueue-time capture; it must not overclaim that an
  already-started slow write cannot temporarily contain an older graph.
- Multiple simultaneous sockets work under the existing serialized-file, finite-timeout and
  `evictAllDurableObjects({ webSockets: 'close' })` setup. The probe records that every response
  body must be consumed before eviction.

#### Exit criteria

The current documentation and the actual toolchain support the collaboration design, the known
write-chain/error-boundary correction is recorded rather than carried as folklore, every throwaway
probe has been deleted, and `pnpm fix`, `pnpm check`, `pnpm test`, and `pnpm test:coverage` pass.

### Phase 17 — Collaborator model

#### Goal

Let an owner grant a previously signed-in identity edit access to one diagram without changing the
anonymous read-only share-link model or adding a new identity/invitation system.

#### Deliverables

1. Add `migrations/0003_create_diagram_collaborators.sql`. Run it locally with `pnpm
   migrate:local` and remotely with `pnpm migrate:remote`, both of which use the repository-root
   `scripts/d1-migrate.ts` helper and `cf`; do not add a Wrangler script or Terraform schema
   resource.
2. Map the source's combined collaborator repository into Architect's tiers: collaborator domain
   values and validation in `domain/`, application ports and use cases in `application/`, and D1
   implementation in `infrastructure/`. Compose the service in `src/worker/index.ts`; routes do not
   construct adapters.
3. Add accessible-diagram application queries returning `owner` or `editor` role while retaining
   the existing owner-only rule for rename, delete, anonymous share management, and collaborator
   management. Use the accessible rule for graph read, the REST graph fallback, and live-upgrade
   authorization.
4. Add owner/collaborator API routes, a dashboard “Shared with me” section, and an editor
   collaborators modal whose add/remove/leave paths distinguish authenticated editing from an
   anonymous read-only link.

#### Tests

- A non-owner/non-collaborator receives the same non-enumerating `404` posture as an absent
  diagram.
- A collaborator can read, live-connect, and edit, but cannot rename, delete, manage share links,
  or manage another collaborator.
- An owner cannot add themselves; adding a never-signed-in email gives the documented safe
  response; adding an existing collaborator is idempotent; and a collaborator can leave.

#### Exit criteria

An owner can add a second known identity, that identity sees the diagram under “Shared with me,” and
all collaborator access is enforced through application services rather than an API-only rule.

### Phase 18 — Bidirectional live operations

#### Goal

Make the existing `DiagramSession` the one serialized graph-write path for browser, REST fallback,
and MCP mutations while D1 remains the diagram's only durable graph copy.

#### Deliverables

1. Replace the one-way `notifyGraphUpdated` model with disposable in-memory graph/owner metadata,
   sequence and a recoverable per-object write-chain tail. Hydrate once after cold start with
   `blockConcurrencyWhile()`; do not add a Durable Object graph schema or `ctx.storage` graph copy.
2. Replace the `DiagramSessionPort` notification method with typed RPC operations such as
   `applyOperation`, `applyWholeGraphReplace`, and `getSnapshot`; retain `connect` as a forwarded
   upgrade request. The infrastructure adapter remains the only layer that knows `getByName`.
3. Grow `src/live-sync-protocol.ts` into a shared discriminated client/server protocol with snapshot,
   operation-applied and operation-rejected frames. Keep verified identity attachment pinning and
   named inbound-header scrubbing.
4. Apply a graph mutation synchronously with no `await` between reading and replacing the working
   graph, then await its ordered D1 persist **before** broadcasting the accepted operation or
   settling the handler. This repository's persist-before-broadcast rule prevents a connected client
   rendering a change that a reload would not show after a failed D1 write. A failed persist must
   report safely and leave a caught chain tail that later operations can still join; expected
   stale-target and validation errors become safe rejections rather than uncaught object failures.
5. Move the REST whole-graph save fallback and every MCP graph mutation/auto-layout through that
   same session port. Remove the obsolete direct-D1-then-`notifyGraphUpdated` path.
6. Send browser edits as debounced operations while connected, reconcile the echoed client operation
   id, and use REST whole-graph save only until a live socket is connected or reconnects.

#### Tests

- Every granular mutation kind exercises the shared serialization path; two concurrent same-target
  operations have one last-applied winner, different targets both survive, and a stale target gets
  `operation_rejected` without closing its socket.
- The slow-first/fast-second counter-example fails against an unchained test double and passes
  against the chain. A three-operation probe separately proves why each queued link reads current
  graph state when it begins, without claiming a write already in flight is retroactively replaced.
- An MCP mutation and a connected human mutation converge in browser frames and D1; the REST
  fallback has the same property; a post-eviction session rehydrates D1 rather than an empty graph.

#### Exit criteria

Two simulated editors and an MCP tool against one diagram converge through one `DiagramSession`
write path, D1 ends in last-applied state, and no graph has a second durable copy.

### Phase 19 — Presence and cursors

#### Goal

Add lightweight, live-only awareness of connected collaborators without turning presence into graph
state or durable data.

#### Deliverables

1. Add stable-per-session collaborator colours, connection snapshots/join/leave, and relayed
   throttled cursor and selection frames to the bidirectional session protocol.
2. Build the editor avatar stack, remote cursor overlay, and advisory selected node/edge highlight
   using the shared frames and existing UI primitives.
3. Reconstruct needed identity from socket attachments after hibernation. Presence/cursor/selection
   data never enters D1 or Durable Object storage and may rebuild from connected clients.

#### Tests

- A new socket receives an accurate presence snapshot; a disconnected socket produces
  `presence_left` for the remaining clients.
- Cursor/selection delivery is scoped to the diagram and adds no D1 graph write. Hibernation and
  reconnect rebuild the observable state without trusting a client-supplied identity.

#### Exit criteria

Two authenticated browser profiles viewing one shared diagram see each other’s presence, cursor and
selection while the graph remains D1's only durable copy.

### Phase 20 — Collaboration verification

#### Goal

Close the collaboration feature as a documented, fully verified extension of the existing demo.

#### Deliverables

1. Close coverage gaps across all three Vitest projects and retain at least 80% statements,
   branches, functions and lines for authored source.
2. Update `README.md`, `DEMO.md`, and `EXPLAIN-DEMO.md` for collaborator routes, the presenter
   flow, node/edge last-applied-wins, the deliberate no-CRDT boundary, D1-only durability, and the
   relationship to MCP live sync.
3. Perform a two-identity browser smoke review covering grant/revoke or leave, simultaneous
   node/edge edits, presence/cursors, stale rejection and an MCP operation while both editors are
   open.

#### Tests

- Verify operation ordering and the unchained clobber counter-example, stale-target rejection,
  reconnect snapshots, owner/editor policy, hibernation reconstruction, error-chain recovery, and
  absence of a Durable Object graph store.
- Retain fresh ids per durable session, serialized integration files, finite test/hook timeouts,
  `evictAllDurableObjects({ webSockets: 'close' })`, and body draining for every response before
  teardown.

#### Exit criteria

`pnpm fix`, `pnpm check`, `pnpm test`, and `pnpm test:coverage` pass; the coverage gate remains at
least 80% on every metric; manual two-identity review passes; and this `cf` + Terraform demo has no
Wrangler command, config file, generation step, or Terraform plan requirement.

## 13. Phases 21–26 — AI assistance

These phases implement `09D-ARCHITECT-AICHAT.md`, after re-retrieving all current Workers AI, AI
Gateway, Agents SDK and documentation-MCP guidance.

- **Phase 21:** spike model, AI Gateway, tool-call wire schema, cost/log correlation and Durable
  Object lifecycle.
- **Phase 22:** implement validated agent tooling and Cloudflare documentation client.
- **Phase 23:** add `DiagramSession` chat capability without bypassing shared operations/services.
- **Phase 24:** port/add source-compatible in-editor chat UI and reloadable turn state.
- **Phase 25:** add blueprint-page generation from a natural-language description.
- **Phase 26:** verify authorization, prompt/tool validation, tool failures, streaming lifecycle,
  persistence, broadcasts, observability and cleanup.

## 14. Definition of complete

Architect is complete only when its documented layer has source-faithful UX, passes all automated
and visual gates, demonstrates the stated Cloudflare product lesson without redundant state or
unowned resources, and can be deployed then completely removed by the commands in its README.
