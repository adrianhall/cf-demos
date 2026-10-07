# Architect

Architect is a Cloudflare-centric architecture diagram tool: a React Flow canvas backed by a
Cloudflare Worker, D1, Workers KV, Static Assets and Cloudflare Access.

This directory currently contains **Phases 1–4** of the port: the deployable lifecycle and original
2,023-line stylesheet; production-equivalent Cloudflare Access policy; the source application
header, identity states, three-state appearance control, landing page, catalogue-backed hero
diagram; the initial user-directory side effect; the complete creation journey — the eight blueprint
templates, the filterable gallery with real React Flow thumbnails, the two-column create modal, and
the personal dashboard with duplicate and delete — and the full single-user editor.

The editor retains the source Zustand model, undo/redo, 500 ms whole-graph autosave, searchable and
persistently collapsible service palette, drag/drop and click-to-add paths, node/edge properties,
responsive side drawers, keyboard shortcuts, status bar, custom React Flow renderers, the
native-form **Connect nodes** dialog, and browser-only ELK auto-layout. ELK remains behind a dynamic
import: the built-bundle contract fails if its roughly 1.4 MB chunk is folded into the initial
editor bundle. Sharing, export/print, and administration remain temporary views or absent controls
until their matching phases in
[`../../specs/architect/02-implementation.md`](../../specs/architect/02-implementation.md); those
placeholders are not re-authored substitutes for the source components.

## Why this is a port

The working application is prior art, not a loose inspiration. Client files are copied as whole
units wherever their dependencies permit it, then adapted only at data, Access and configuration
seams. In particular, [`src/client/app.css`](src/client/app.css) is copied verbatim: its tokens,
contrast commentary, responsive breakpoints and print rules are part of the product. A built-output
contract fails `pnpm check` if the brand colour, system font stack, design tokens or native
`light-dark()` semantics drift.

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
- `/api/admin/*` — an administrator-only router with no handlers until the administration phase.
  Ordinary identities receive `403`; the configured administrator passes authorization and receives
  `404` for the not-yet-present endpoint.

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

## Storage choices

- **D1 is authoritative** for diagrams and the user directory. Read replication is disabled because
  an editor save must be visible to the next read.
- **Workers KV is disposable** and will cache share-token-digest → diagram-id lookups. D1 remains
  authoritative for share lifecycle; losing KV must never lose a share record.
- A later **Durable Object** coordinates live sockets only. It does not keep a second durable graph.

The first migration preserves two deliberate schema decisions: no foreign keys, and no
`users.is_admin` column. The single administrator is operator configuration (`ADMIN_EMAIL`), checked
against a verified Access identity on every administrative request, not mutable database state.

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
