# Architect

Architect is a Cloudflare-centric architecture diagram tool: a React Flow canvas backed by a
Cloudflare Worker, D1, Workers KV, Static Assets and Cloudflare Access.

This directory contains **Phases 1–7 (Layer 1)** of the port: the deployable lifecycle and complete
source stylesheet; production-equivalent Cloudflare Access policy; the source application header,
identity states, three-state appearance control, landing page, catalogue-backed hero diagram; the
initial user-directory side effect; the complete creation journey — the eight blueprint templates,
the filterable gallery with real React Flow thumbnails, the two-column create modal, and the
personal dashboard with duplicate and delete — the full single-user editor, read-only anonymous
sharing, the administrator directory and moderation surface, browser PNG/SVG/scaffold exports, print
mode, guarded local preferences, the complete 35-finding source regression audit, WCAG 2.2 AA
review, and production-bundle performance contract. See [`BUG-AUDIT.md`](BUG-AUDIT.md) for the
bug-by-bug evidence and browser record, [`DEMO.md`](DEMO.md) for a presentation walkthrough, and
[`EXPLAIN-DEMO.md`](EXPLAIN-DEMO.md) for the architectural lessons.

The editor retains the source Zustand model, undo/redo, 500 ms whole-graph autosave, searchable and
persistently collapsible service palette, drag/drop and click-to-add paths, node/edge properties,
responsive side drawers, keyboard shortcuts, status bar, custom React Flow renderers, the
native-form **Connect nodes** dialog, browser-only ELK auto-layout, browser PNG/SVG capture, project
scaffold ZIP, and print mode. ELK remains behind a dynamic import: the built-bundle contract fails
if its roughly 1.4 MB chunk is folded into the initial editor bundle.

## Why this is a port

The working application is prior art, not a loose inspiration. Client files are copied as whole
units wherever their dependencies permit it, then adapted only at data, Access and configuration
seams. In particular, [`src/client/app.css`](src/client/app.css) retains the source tokens, contrast
commentary, component rules, responsive breakpoints and print rules. Phase 6 adds one documented
correction found in real-browser review: an explicit theme-aware body background/text pair. Without
it, system/dark mode could combine a dark `--cf-surface` with black UA body text. A built-output
contract fails `pnpm check` if that pair, the brand colour, system font stack, design tokens or
native `light-dark()` semantics drift.

The app deliberately remains a plain React SPA. Links into `/app*` are ordinary document
navigations, which lets Cloudflare Access intercept the request before a protected bundle runs. A
client-side router would resolve the path inside an already-loaded bundle and remove that
interception point.

## Prerequisites

- Node.js 24 or newer
- pnpm 12 or newer
- Terraform 1.10 or newer
- A Cloudflare account with a domain and a configured Zero Trust identity provider
- A repository-root `.env`, created with `pnpm create-env`

The API token permissions are documented in the repository-root
[`.env.example`](../../.env.example). This demo reads no per-demo `.env` and needs no `.dev.vars`.

## Local development

From the repository root:

```sh
pnpm install
cd cf-terraform-demos/architect
pnpm start
```

`pnpm start` applies the committed D1 migrations to the local simulation, then runs `cf dev` with
state persisted under `.cloudflare/state`. It uses only the committed
[`infra/local-outputs.json`](infra/local-outputs.json) fixture: no live Terraform state or cloud
resource is read.

The local Access emulator offers two identities:

- `admin@example.com`, matching the committed local `ADMIN_EMAIL` placeholder;
- `alice@example.com`, an ordinary user.

The source-faithful landing page is available at the URL printed by `cf dev`. `/api/health` is
public; `/api/me` and future management APIs exercise the same Access middleware and audience check
used in production. The common header treats an unauthenticated `/api/me` response as an ordinary
anonymous state on a public page, while an Access-gated `/app*` page surfaces it as an error.

The appearance control cycles system → light → dark → system. System is represented by **no stored
preference and no inline `color-scheme` override**; explicit light/dark choices are persisted. This
distinction matters when the OS scheme changes while the page is open.

## Commands

| Command              | Purpose                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm start`         | Apply local D1 migrations, then run the local application and Access emulator.                                                 |
| `pnpm check`         | Generate binding types and verify TypeScript, Oxfmt, Oxlint, naming, built CSS, and Terraform without changing authored files. |
| `pnpm fix`           | Apply Oxfmt, safe Oxlint fixes, and Terraform formatting.                                                                      |
| `pnpm test`          | Run client, Worker, Workers-runtime integration, and built-artifact tests.                                                     |
| `pnpm test:coverage` | Run the suite with Istanbul's 80% statements/branches/functions/lines gates.                                                   |
| `pnpm deploy`        | Apply Terraform, write outputs, migrate remote D1, build, and upload with `cf deploy --prebuilt`.                              |
| `pnpm teardown`      | Resolve and delete this demo's Worker, then destroy Terraform-owned infrastructure.                                            |

Every namespaced step (`check:types`, `deploy:infra`, `migrate:remote`, and so on) is independently
runnable when diagnosing one stage.

## Deployment lifecycle

> **Do not deploy just to test this phase.** Local development and the complete offline test suite
> cover it. The commands below create and remove real resources.

Terraform owns the Worker registration/bootstrap deployment, custom hostname, Access applications,
D1 database and Workers KV namespace. `cf` owns the application code upload and deploy-time
bindings. Neither tool recreates the other's resources.

```text
pnpm deploy
  terraform apply
  → write infra/outputs.json
  → apply remote D1 migrations
  → Vite / Cloudflare build
  → cf deploy --prebuilt

pnpm teardown
  resolve worker_name from Terraform state
  → cf workers delete --force
  → terraform destroy
```

The Worker is deleted first because Cloudflare refuses to delete D1/KV resources still bound to a
live Worker. Terraform also records explicit Worker-to-storage dependency edges, ensuring safe
reverse ordering if the lifecycle is invoked directly.

## Access model

Terraform owns two applications on the configured hostname:

- a hostname-wide public bypass for the landing page, blueprint gallery and anonymous share viewer;
- a narrower authenticated application for `/app*`, management APIs and the reserved future `/mcp*`
  path.

The authenticated application deliberately enumerates API destinations rather than claiming
`/api/*`, because the later anonymous share resolver lives under that prefix and must stay public.
The same ordered policy builder drives local Access emulation and Worker-side verification; every
API and MCP policy uses `redirect: false`, so a programmatic caller receives an RFC 9457 `401`
rather than HTML from a login redirect.

Edge Access is not authorization. The Worker validates the exact Access application audience, and
administrative routes additionally compare the verified email to the Terraform-provided
`ADMIN_EMAIL`. There is no role column or promote/demote flow.

## Naming and coexistence

This port intentionally coexists with the deployment it was ported from. The Worker name and
hostname are therefore Terraform variables declared in [`infra/providers.tf`](infra/providers.tf),
not literals in scripts or application code. Their initial coexistence values appear only as the
variable defaults in `infra/providers.tf`; downstream consumers never restate them.

Both values flow through documented scalar Terraform outputs into
[`cloudflare.config.ts`](cloudflare.config.ts). Teardown resolves `worker_name` from live Terraform
state rather than writing a name into `package.json`. `pnpm check:naming` scans the demo for
literals that could reach the reference deployment or survive a rename.

To see the effective deployed values after applying Terraform:

```sh
terraform -chdir=infra output -raw worker_name
terraform -chdir=infra output -raw hostname
```

Do not change the variable defaults for cutover until the source-parity checkpoint in the
implementation plan is complete and the previous deployment has released its names.

## Architecture baseline

Dependencies point in one direction:

```text
React UI → Hono routes → application services → domain/ports → infrastructure adapters
```

[`src/worker/index.ts`](src/worker/index.ts) is the composition root. It constructs the D1 diagram
and user adapters and their services once per request, then injects them into middleware and routes;
nothing under `routes/` imports from `infrastructure/`, so a handler could not construct a
repository even if it tried. Future share services follow the same seam.

Three modules are shared between the client and the Worker rather than owned by either:
[`src/catalog.ts`](src/catalog.ts), [`src/blueprints.ts`](src/blueprints.ts) and
[`src/graph-element-types.ts`](src/graph-element-types.ts). The last is the smallest and the most
load-bearing: it holds the two React Flow type keys every stored node and edge carries, and a
literal re-typed independently on either side would render as React Flow's unstyled default rather
than failing a build.

The Worker currently exposes:

- `GET /api/health` — public liveness, returning `{ "status": "ok" }`;
- `GET /api/me` — authenticated `{ email, isAdmin }`, derived only from the verified Access identity
  and `ADMIN_EMAIL`;
- `GET/POST /api/diagrams` — list the caller's own diagrams, or create one blank or from a named
  blueprint;
- `GET/PATCH/DELETE /api/diagrams/:id` — read, rename, or delete one owned diagram;
- `PUT /api/diagrams/:id/graph` — validate and replace an owned diagram's graph;
- `POST /api/diagrams/:id/duplicate` — copy an owned diagram;
- `GET/POST/DELETE /api/diagrams/:id/share` — read an owned diagram's share status, mint or rotate
  its read-only link, or revoke it;
- `GET /api/shares/:token` — public, anonymous resolution of a share link to a deliberately limited
  projection;
- `GET /api/admin/users` — administrator-only, paginated user directory with live diagram counts;
- `GET /api/admin/diagrams/:id` — administrator-only, owner-blind moderation preview;
- `DELETE /api/admin/diagrams/:id` — administrator-only moderation delete with share cleanup.

Every administrative path rechecks the verified identity against `ADMIN_EMAIL`, including a path
that does not exist: an ordinary identity receives `403` before routing and cannot use response
status to discover which administrative routes are real. The configured administrator receives the
route's own result.

Every diagram route answers `404` — never `403` — for a diagram that does not exist, that is
malformed, or that belongs to another identity. The three are deliberately indistinguishable in both
status and body: a `403` would confirm to a caller that a guessed id is real. That rule lives in one
private method of `DiagramService`, so no use case can reach storage without passing through it, and
the repository port stays authorization-neutral.

Authentication best-effort upserts the verified identity into D1's lightweight `users` directory.
The service absorbs a directory-write failure so it cannot take down the caller's request, but logs
a structured warning so a persistently unwritable directory is observable. The directory is never an
authorization source.

Every mutation passes same-origin and exact `application/json` checks before routing. The shared
`@demos/worker-common` Access middleware and `@adrianhall/cloudflare-toolkit` logging, not-found and
RFC 9457 error handlers are used from the first route onward. Production responses never include
stack traces.

## Sharing

An owner can hand out a read-only link to one of their diagrams. The link grants reading that one
diagram and nothing else: it is not an identity, so it reaches neither the owner's other diagrams
nor any management endpoint.

**A raw share token is never stored.** Only its SHA-256 digest is written — in D1's
`diagram_shares.token_digest` and as the `SHARES` KV key — and nothing logs it. The token is
returned by exactly one response, the `POST` that mints it, and that response is the only moment it
exists outside the holder's own browser. A reader working from the deployed account's data, or from
its observability logs, cannot reconstruct a working link.

Two visible consequences follow, and both are deliberate rather than unfinished:

- **Share status reports only _that_ a link is active**, never its URL. The server cannot reproduce
  one. An owner who has lost their link generates a new one, which revokes the old.
- **At most one link is live per diagram.** Creating a link revokes any previous one in the same
  operation, so "revoke" is a complete action rather than a per-link one. The revoked row is kept
  with a `revoked_at` timestamp as a record that the link once existed.

Sharing is a **live pointer**, not a snapshot: the resolver reads the diagram's current graph at
request time, so an edit the owner makes after sharing is visible through the same link immediately
and there is no second copy to keep in step. Deleting a diagram cascades a revocation of every link
to it, in the delete use case itself rather than in the route, so an MCP tool deleting a diagram in
a later phase leaves the same state behind.

A malformed token, an unknown one, a revoked one and one pointing at a deleted diagram are all
answered with the same `404` and the same problem detail. They are indistinguishable on purpose:
anything that told them apart would make the public endpoint an oracle for probing live links.

The resolver lives at `/api/shares/:token` — under the otherwise authenticated `/api` prefix — and
stays public because three things agree: the shared policy list carves it out ahead of the general
`/api` rule, the Terraform authenticated application simply omits it from its destinations so it
falls through to the hostname-wide bypass, and the router itself serves only `GET`. That last point
is what makes it safe for an anonymous cross-origin read, which is exactly what a link pasted into a
chat client produces.

## Administration

The administrative page deliberately presents two surfaces that cannot be composed into a browser
for other people's content:

- the directory answers **who has used this deployment, and how much**, listing email, display name,
  first/last-seen timestamps and a live diagram count — never diagram titles or ids;
- moderation answers **what is in this one named diagram**, returning the same owner-blind
  projection the anonymous share viewer receives — never the owner.

Diagram ids reach an operator out of band or from the D1 console. Previewing and deleting one is
then a deliberate, individually logged operation. Moderation deletion calls the same application use
case as owner deletion, so both leave exactly the same state: no diagram and no active share link to
it. The count is computed at read time from `diagrams.owner_email`, not denormalised, so it follows
both kinds of delete without a counter to drift.

## Export and print

PNG and SVG export are browser-only because they capture the actual DOM/React Flow layout. The
browser computes the whole graph's bounds and a fitted transform, independent of the visitor's
current pan/zoom, then downloads a white-background image with a timestamped filesystem-safe
filename. Project export is DOM-free: a pure generator maps catalogue nodes into a ZIP containing a
typed `cloudflare.config.ts`, Worker/Hono/Astro entry point, package scripts and optional Drizzle/D1
files.

The generated scaffold is the one deliberate Phase 6 behaviour difference from the source. The
source emitted `wrangler.toml` and Wrangler commands. This repository exists to teach the `cf`
control plane that supersedes Wrangler, so the generated starter uses `cf/config`, `cf dev`,
`cf workers types` and `cf deploy` instead. This was an explicit implementation choice rather than
an accidental porting drift.

Print mode forces a light scheme, picks portrait or landscape from the graph's aspect ratio, fits
the whole diagram, removes editor chrome, adds the diagram title/description and opens the browser
print dialog after a paint delay. `afterprint`, the visible **Back** control, and component unmount
all restore the prior colour scheme and remove the injected `@page` rule.

## Resources and clean teardown

A deployment creates exactly these resources:

| Resource                                           | Lifecycle owner | Purpose                                           |
| -------------------------------------------------- | --------------- | ------------------------------------------------- |
| Worker registration, bootstrap and custom hostname | Terraform       | Stable application identity and route             |
| Worker code and deploy-time bindings               | `cf`            | The built Hono/React application                  |
| D1 database                                        | Terraform       | Authoritative diagrams, users and share lifecycle |
| Workers KV namespace                               | Terraform       | Disposable digest → diagram-id share lookup cache |
| Public bypass Access application/policy            | Terraform       | Public landing, gallery and share routes          |
| Authenticated Access application/policy            | Terraform       | `/app*` and management APIs                       |

`pnpm teardown` deletes the deployed Worker before Terraform destroys its D1/KV/Access/hostname
resources. That ordering releases live bindings first. It does not touch the separate source
reference deployment: the naming contract rejects source hostname/Worker literals outside the two
Terraform defaults reserved for this port.

## Deliberate limitations

- Layer 1 is a single-user editor. MCP, live collaboration and AI assistance are specified future
  layers, not partially hidden features in this build.
- Whole-graph autosave is last-write-wins within one owner's browser sessions; collaborative
  operation ordering belongs to the later Durable Object layer.
- Anonymous shares are read-only live pointers, not snapshots, and there is one active link per
  diagram. Losing a raw URL requires rotation because the server stores only its digest.
- Administration is intentionally one configured identity. There is no role table, invitation flow,
  or first-user bootstrap.
- Browser image export captures rendered DOM and therefore has no server API. Project export is a
  portable starter, not a complete reverse-engineering of arbitrary diagram topology.
- ELK auto-layout is browser-only and downloaded only when requested. It is absent from Workers
  because ELK cannot execute in `workerd`.
- The generated scaffold intentionally uses `cf`, unlike the Wrangler-based source scaffold. This is
  the only deliberate Layer 1 platform-facing source deviation.

## Regression, accessibility and performance audit

[`BUG-AUDIT.md`](BUG-AUDIT.md) maps all 35 source findings to focused tests, built-production CSS,
or real-browser checks. It also records the WCAG 2.2 AA review and explains why React Flow fitting,
responsive drawer geometry, target boxes, focus paint and hit-testing cannot be validated by jsdom.

The performance contract is artifact-based: `tests/worker/built-bundle.test.ts` requires ELK to stay
in one dynamic chunk and out of the initial application bundle. The Phase 7 production build emitted
a 602.34 kB initial JS entry and a separate 1,431.11 kB ELK chunk loaded only by Auto layout.

## Storage choices

- **D1 is authoritative** for diagrams, the user directory and the share lifecycle. Read replication
  is disabled because an editor save must be visible to the next read.
- **Workers KV is disposable**: it answers the one question an anonymous share request asks, digest
  → diagram id, with no identity and no relational query involved. Every read falls back to D1 on a
  miss, which also covers the short window before a new key has propagated between locations, so
  losing the whole namespace costs a slower first lookup per link and nothing else.
- A later **Durable Object** coordinates live sockets only. It does not keep a second durable graph.

The migrations preserve three deliberate schema decisions: no foreign keys, no `users.is_admin`
column, and no column anywhere a raw share token could be written. The single administrator is
operator configuration (`ADMIN_EMAIL`), checked against a verified Access identity on every
administrative request, not mutable database state.

A diagram's `graph_data` is stored and returned as an opaque JSON string. The Worker validates its
shape on write — an array of nodes and of edges, each an object with a non-empty string `id`, plus a
viewport — and inspects nothing further. `type`, `position` and `data` are the editor's vocabulary,
so a client adding a field needs no server change. The `id` is the exception because the server
itself relies on it: a later phase's granular operations address an element by it, and an element
with no stable identity cannot be the target of one.

## Visual verification

`pnpm start` serves the real stylesheet locally. Before closing a phase, review the local page at
desktop and narrow widths in system, light and dark schemes. Automated coverage is complementary:

- client tests assert structure and behaviour;
- the built-stylesheet contract asserts the original tokens, brand colour, font stack, responsive
  and print rules;
- the contract reads **built output**, because Vite's default CSS transformation lowers
  `light-dark()` into an OS-media-query polyfill that breaks the in-app scheme override while
  continuing to work in development.

`vite.config.ts` excludes that transformation through `Features.LightDark`, and the contract fails
if it regresses.

The React Flow canvases are the clearest case for reviewing in a real browser rather than trusting
the suite. React Flow positions every node absolutely from its own stylesheet, which
[`src/client/main.tsx`](src/client/main.tsx) imports ahead of `app.css`. Without that import a
thumbnail still renders every node, every label and every edge — so every DOM assertion passes — but
lays them out in normal document flow, and a diagram appears as a vertical list of boxes. jsdom
computes no layout, so nothing in the test suite can fail on it. Phase 3 found exactly that defect
in local browser review, which is why the step is a requirement rather than a courtesy.

The Phase 4 browser pass additionally covers drag/drop, node movement, pointer and native-form
keyboard connections, initial blueprint fitting, auto-layout, autosave/reload, both responsive side
drawers, all three appearance states, and the reduced-motion data-flow treatment. The editor's
canvas is a real computed-height viewport: the fit-on-load effect waits for React Flow to measure
the custom nodes, then fits once and never fights a visitor's later pan or zoom.

The Phase 5 browser pass covers the share dialog's three states and its focus handling, copying the
revealed link, and opening that link in a private window — where the read-only viewer must render
the same diagram with no editing affordances, its own banner, and a canvas that pans and zooms but
does not move a node. `.share-view` sets a real `height: 100vh` for the same reason the editor's
main region does; jsdom computes no layout, so that is reviewed in a browser rather than asserted in
a test.

The Phase 6 browser pass covers the administrator/non-administrator postures, accessible directory
table, owner-blind real-canvas moderation preview, export-menu geometry and dismissal, print-mode
chrome removal/fit/title block, and the system/light/dark surface/text pair. The browser's native
print dialog and download destination are not automatable through the panel; focused behavioural
tests assert `window.print()`, capture options, filenames, object-URL cleanup and ZIP contents.
