# Architect — What This Demo Teaches

Architect is a React Flow architecture editor running as a Cloudflare Worker with Static Assets. It
is a faithful Layer 1 port of the established Architect demo: the presentation and behaviour are
prior art; the deployment control plane and Worker internals are rebuilt around `cf`, Terraform,
shared Access middleware and a four-tier architecture.

## The main lesson: one hostname, two trust postures

The hostname is simultaneously public and authenticated:

| Surface                                               | Posture       | Why                                                              |
| ----------------------------------------------------- | ------------- | ---------------------------------------------------------------- |
| `/`, `/blueprints`, `/s/:token`, `/api/shares/:token` | Public bypass | Landing, creation choices and possession-based read-only viewing |
| `/app*`, `/api/me`, `/api/diagrams*`, `/api/admin*`   | Authenticated | Identity-bound data and mutations                                |

Terraform owns two Access applications: a broad public bypass and narrower authenticated application
whose path destinations win by specificity. The anonymous resolver is intentionally omitted from
authenticated destinations even though it lives under `/api`.

Access at the edge is not the whole authorization design. The Worker validates the JWT, exact
application audience and actor again. Every service operation derives the owner from verified
identity; no request body or header supplies an owner. Administrative routes then compare that
identity to `ADMIN_EMAIL` on every request. A valid token from another Access application or an
ordinary signed-in user is insufficient.

## Why the SPA keeps real document navigations

Architect uses a small path selector rather than a client router. Links crossing into `/app*` are
ordinary anchors, so Cloudflare Access can intercept a new request before the protected page runs. A
client-side navigation from an already-loaded public bundle would cross the visual URL boundary
without creating that interception point.

React is chosen because the core editor is React Flow, not as a framework preference. React Flow
provides the measured canvas, graph interaction and viewport transforms that would otherwise be the
largest part of this application.

## Four tiers, one authorization point

```text
React UI → Hono routes → application services → domain + repository ports → D1/KV adapters
```

Routes parse HTTP and shape responses. Application services own use cases and authorization. Pure
domain modules validate diagram metadata, graph payloads and share tokens. Infrastructure adapters
implement repository ports for D1 and KV. `src/worker/index.ts` is the only composition root; routes
never construct repositories.

This separation matters beyond neatness. A future MCP transport can call the same service in-process
without making an internal HTTP request or reproducing ownership checks. Repository ports remain
actor-neutral; services produce the uniform, non-enumerating 404 for malformed, missing and
other-owner diagram ids.

## D1 is authoritative; KV is disposable

D1 stores diagrams, the lightweight identity directory, and the share lifecycle. It is the only
source of truth:

- relational rows support ownership, counts and moderation;
- updates are immediately read back by the editor/share resolver;
- share revocation and diagram deletion have durable records;
- there is no second durable graph to reconcile.

Workers KV is an acceleration index from share-token digest to diagram id. A miss falls back to D1,
which handles propagation delay and means the namespace can be rebuilt without data loss. KV's
eventual consistency is acceptable because it never authorizes a mutation and never holds the
canonical share state.

The `DiagramSession` Durable Object coordinates live sockets only; it persists nothing at all. That
narrow role avoids two independently durable copies silently disagreeing — see "Why a Durable Object
here specifically" below.

## The raw share token does not exist at rest

The create-link response returns a cryptographically random token once. Before storage, the service
hashes it with SHA-256. D1 stores the digest; KV uses the digest as its key; logs contain neither
raw token nor graph content.

This security rule is intentionally visible in the product. Share status can say that a link is
active but cannot reproduce its URL. If the owner loses it, rotation creates a new token and revokes
the old one. Malformed, unknown, revoked and deleted-target tokens all return the same 404 so the
public endpoint cannot become a token-validity oracle.

A share is a live read-only pointer, not a copied snapshot. Resolution looks up the current D1
graph, so edits appear at the same URL and there is no snapshot to drift.

## Administration is configuration, not mutable role data

The `users` table records identities observed through successful Access verification and powers the
administrator directory. It is never an authorization source. There is no `is_admin` column, no
first-user bootstrap and no promote endpoint. Exactly one configured `ADMIN_EMAIL` is authorized.

The directory returns identities and live diagram counts, but no diagram titles. Moderation looks up
one out-of-band diagram id and returns an owner-blind projection, reusing the public share shape. A
moderation delete calls the same deletion use case as an owner and therefore performs the same share
cleanup.

## Accessibility is part of the editor model

The source application's accumulated WCAG fixes are part of the port contract, not optional polish:

- service buttons offer a click/keyboard fallback to drag-and-drop;
- a native-select **Connect nodes** dialog provides a keyboard and switch-access alternative to
  React Flow's pointer-only handles (WCAG 2.1.1 and 2.5.7);
- all dialogs share initial focus, Tab trapping, Escape close and focus restoration;
- the canvas has a visible focus indicator and a diagram-specific top-level heading;
- previews hidden from assistive technology also disable node/edge focusability;
- field, node and danger colours preserve measured AA/non-text ratios in both themes;
- controls meet the 24 CSS px WCAG 2.2 target minimum;
- at narrow width, side panels overlay rather than squeezing the canvas;
- directional edge motion stops under `prefers-reduced-motion`.

[`BUG-AUDIT.md`](BUG-AUDIT.md) maps all 35 source findings to their focused tests, built CSS checks
or browser verification. Geometry requires a real browser: jsdom does not calculate boxes, paint
focus, evaluate media queries, perform hit testing, measure fonts or run React Flow's viewport
fitting.

## Production CSS is a functional contract

The app uses native `light-dark()` tokens driven by `color-scheme`. An explicit light/dark choice is
an inline `color-scheme`; system mode removes that override.

Vite's default Lightning CSS transformation can lower `light-dark()` into a `prefers-color-scheme`
media query. That query follows the OS directly and cannot see the in-app property override.
Development appears correct while production buttons, surfaces and borders stay stuck in the OS
scheme. `vite.config.ts` excludes that transformation, and the built-stylesheet test proves native
syntax remains after minification.

The same artifact contract checks the exact brand orange, system font stack, full token set,
contrast values, responsive/print rules, motion override, focus ring, target sizes and geometry
rules. A source-only assertion would miss the original build-only failure.

## ELK is paid for only when used

Auto-layout uses ELK in the browser. `computeAutoLayout()` performs a dynamic `import()` when the
visitor activates **Auto layout**; no Worker imports ELK because its browser bundle cannot execute
in `workerd`.

The Phase 7 build emitted a 602.34 kB application entry and a separate 1,431.11 kB ELK chunk. The
bundle contract checks that ELK's algorithm marker occurs in exactly that one chunk and every other
chunk stays below an inlining tripwire. Opening an editor therefore does not transfer the optional
layout engine; the button is the network boundary.

## Export and print stay client-side

PNG/SVG export captures the actual React Flow DOM using graph bounds and a fitted transform, so the
file is independent of the current viewport. This cannot be reproduced faithfully in the Worker.
Print mode similarly manipulates page layout, colour scheme and the native print dialog, then
restores every change after print/cancel/unmount.

Project export is different: it is a pure graph-to-files transformation and produces a ZIP starter.
The one deliberate source deviation is that this port generates typed `cf/config` and `cf` commands
instead of the source demo's obsolete Wrangler scaffold. That change teaches the repository's
current control plane rather than preserving retired deployment mechanics.

That purity is why the `export_diagram` MCP tool can offer `json` and `scaffold` and nothing else:
the Worker imports the **same** `generateScaffold`, zips it with `fflate` server-side and returns
base64, so an agent and the toolbar button hand a reader byte-identical projects. PNG and SVG have
no such shared path, and the tool's own description says so to the calling model rather than leaving
it to infer the gap from a failure.

## A second transport, not a second application

The remote MCP server at `POST /mcp` is the clearest payoff of the four-tier separation, and it is
worth being precise about why. Adding an agent-facing surface to an application usually means
writing a second one: a second way in, a second place the ownership rule is expressed, and a second
set of validation that has to be kept in step with the first by review. This demo adds none of that.
Every tool calls the same `DiagramService` and `ShareService` the HTTP routes were given, as an
in-process call rather than an internal fetch, so the agent transport inherits the ownership rule,
the validation and the uniform non-enumerating `404` rather than reproducing them.

That is why the test that matters most is the one asserting a non-owner gets the same refusal, in
the same words, from both `GET /api/diagrams/:id` and `get_diagram`. It is not checking that two
implementations agree; it is checking that there is still only one.

The design also teaches three things about remote MCP on Workers specifically.

**Stateless is the right default, and here it is right on the merits.** Every tool's state is a D1
row, so nothing needs to survive between two MCP requests, and an MCP session identifier would be a
second place for durable data to hide. The deprecated `McpAgent` would have created exactly that
hiding place for no benefit.

**Per-request identity does not require a per-request handler.** The obvious hazard with a
module-scope handler is freezing the first caller's identity into a singleton that then serves
everyone, and the obvious remedy — constructing a fresh handler per request — is no longer
necessary. `createMcpHandler` invokes its server _factory_ once per request, so a server instance,
and therefore every tool closure registered on it, is already scoped to one caller. Nothing
identity-shaped is stored on the handler, which is what makes a single long-lived one safe.

**The identity arrives as a header, not as a token.** Cloudflare Access resolves an MCP client's
opaque OAuth token at the edge and forwards a signed `Cf-Access-Jwt-Assertion`, so the Worker sees
exactly what it sees for a browser and needs no OAuth code of its own. The SDK's `authInfo` is
deliberately unused: it describes an OAuth _client_, not a user, and populating it would mean
inventing a value.

One honest consequence runs through the whole catalogue: a tool's description is its contract with a
model that will never read this file. So `auto_layout_diagram` says plainly that its grid is simpler
than the editor's own layered layout, `export_diagram` says PNG and SVG are browser-only, and
`get_share_status` says it can never reproduce a lost link. A model told none of that would promise
a user something the server cannot do, which is a worse failure than refusing.

## Why a Durable Object here specifically

This repository's default posture is to avoid a Durable Object. Most state belongs in D1 or KV, and
most "live" requirements are adequately served by a reload or a poll — choosing an object for them
adds a coordination primitive to a problem that did not have one.

Live sync is the case that genuinely does. An agent changing a diagram through `/mcp` has to reach
an editor tab that is already open, and "push the instant something changes to every currently
connected client" is a persistent-connection fan-out problem rather than a data-access one. Neither
D1 nor KV has any notion of a connected reader, and no amount of polling produces the demo's central
moment, which is that the canvas updates _as the agent acts_.

The justification is narrow and the object is narrow to match. It provides exactly two things D1
cannot: it holds the open WebSockets, and it is a single addressable point per diagram, so there is
no "which replica holds the sockets" question to answer. It provides nothing else — in particular no
storage, which is the discipline that keeps the justification honest. The moment such an object
starts keeping a copy of the data it is fanning out, the "coordination, not data access" argument
stops being true and two durable copies begin disagreeing.

`DiagramSession`, one instance per diagram id, holds every WebSocket currently open on that diagram.

The connection lives in the object rather than in a Worker because a Worker isolate can be evicted
and the socket is then simply lost — nothing durable is holding it. It is accepted with
`ctx.acceptWebSocket()`, the Hibernation API, so a tab left open overnight stays connected at the
edge while the object is evicted and stops costing anything.

**The session stores nothing.** D1 stays the one authoritative copy of every diagram; the object is
only a fan-out point. Two independently persisted copies of one diagram can silently disagree, and
reconciling them would be a whole second problem this demo does not need.

Three consequences are worth reading the code for:

- **The upgrade is forwarded, not replaced by RPC.** A `WebSocket` cannot be serialized across an
  RPC boundary, and the Hibernation API completes the protocol switch against the incoming request,
  so the request must reach the object. Every other call into it — `notifyGraphUpdated` — is a typed
  RPC method. The upgrade is the exception, not the pattern.
- **The identity therefore travels as a header, and is scrubbed in one function.**
  `withVerifiedIdentity` deletes any inbound copy before setting the verified value, so the two
  cannot be half-performed. The session may trust that header for one reason: it has no route of its
  own, so the only way in is through a Worker that authenticated the caller and checked ownership
  first. A smuggled header is asserted ignored at the unit level — including a differently-cased
  spelling — and again through the real runtime.
- **Persist, then broadcast.** Broadcasting first would let a browser render a graph a later reload
  would not show.

`GET /api/diagrams/:id/live` sits under `/api/` deliberately, so Access and `runWorkerFirst` already
cover it. That policy uses `redirect: false`, which matters more here than anywhere else: a
browser's `WebSocket` constructor cannot follow a redirect to a login page, so redirecting an
unauthenticated upgrade would surface as an unexplained connection failure rather than an
authentication error. A non-upgrade request gets `426 Upgrade Required`, not `400` — the request is
well-formed and the diagram exists; it is the protocol that is wrong.

## Last-write-wins is the designed boundary

The live channel is **one-way**: server to client. The browser's own edits keep using the debounced
whole-graph autosave. This layer adds a read channel, not a second write path.

That asymmetry is the whole concurrency design, and it is worth stating as a decision rather than
leaving to be inferred. Two writers reach a diagram's graph: the browser, which replaces the whole
graph on a 500 ms debounce, and the owner's own agent, which applies one granular mutation per tool
call. They are not merged. The last write to commit wins outright, which is exactly the model the
autosave has had since before MCP existed — there is no partial-patch protocol in either direction,
so there is nothing for a merge to operate on.

Three facts make that acceptable **at this scope**, and naming the scope is the point:

- **Both writers are the same person.** An agent acts with its owner's identity and no other; every
  write is an owner-scoped `UPDATE ... WHERE id = ? AND owner_email = ?`. There is no
  read-modify-write race across two identities, because there is only ever one identity involved.
- **A lost race costs a repaint, not data.** A push that arrives mid-edit replaces the canvas; the
  user's own pending autosave fires shortly after and overwrites it back. That is a brief visual
  flicker, and `updated_at` always reflects whichever write actually landed last, so the diagram is
  never in a state neither writer produced.
- **The client refuses a stale push.** A `graph_updated` frame is applied only when its `updatedAt`
  is newer than what the tab already holds, so a push that lost a race is discarded rather than
  reverting a change the user can see.

When a push is applied, a dismissible "Updated by an agent" notice explains why the canvas changed.
A diagram that rewrites itself with no explanation reads as a bug rather than as the feature it is.

**What this deliberately does not solve**, and would need to before the scope widens: two people
editing one diagram. Every assumption above fails there. The writers are no longer one identity, so
a whole-graph replace silently discards somebody else's work rather than one's own; a flicker
becomes data loss; and `updated_at` stops being enough to decide what should win, because the two
writes were not alternatives but independent changes that both wanted to happen. Fixing that needs
per-operation ordering, a serialized write path through the session, and presence so a person can
see they are not alone — which is what the later collaboration phases add, by extending this same
`DiagramSession` rather than building a second per-diagram object beside it.

This boundary was chosen up front and is recorded here so it reads as the scope decision it is,
rather than being discovered later and written up as a limitation.

## Infrastructure ownership and lifecycle

Terraform owns resources with durable lifecycle: D1, KV, Worker registration/bootstrap, custom
hostname, DNS route and Access applications/policies. `cf` owns code upload and deploy-time
bindings. Neither creates the other's resources.

The `DIAGRAM_SESSIONS` Durable Object namespace is the one exception, and it follows the same rule
rather than breaking it. A namespace is defined by the class its Worker exports, so it is created by
the deploy that uploads that class and retired when the code stops exporting it — Terraform cannot
own its full lifecycle, and splitting it would give one resource two owners. It is declared in
`cloudflare.config.ts` as `exports.durableObject({ storage: 'sqlite' })` plus a matching binding.
`cf` models retirement as a `state: 'deleted'` entry on the export rather than as Wrangler's
append-only migration tags, so removing a class is an edit to a live declaration rather than a tag
that must never be reused. Deleting the Worker removes the namespace, and nothing is lost with it
because the sessions store nothing.

```text
pnpm deploy
  Terraform apply → output ids → D1 migration → production build → cf deploy --prebuilt

pnpm teardown
  cf workers delete → Terraform destroy
```

Deleting the Worker first releases live D1/KV bindings before Terraform destroys them. Worker name
and hostname flow from Terraform variables through scalar outputs; the naming contract prevents this
port's lifecycle from reaching the separate source deployment.

## Deliberate limitations

- Live sync is one-way. An agent's change reaches an open editor; a second person editing the same
  diagram, presence, cursors and per-operation merge are a later layer, not hidden routes.
- Whole-graph autosave is last-write-wins across simultaneous tabs, and the same applies between a
  user and their own agent — see "Last-write-wins is the designed boundary" above. Granular ordered
  operations exist server-side for the MCP tools only; the browser still saves the whole graph.
- Server-side auto-layout is a deterministic grid, not ELK, because ELK cannot run in `workerd`. The
  `auto_layout_diagram` tool description says so plainly, so a calling model does not promise a user
  the editor-quality layout it will not get.
- One anonymous link per diagram is active at a time, read-only, and non-recoverable after its
  one-time disclosure. That holds for the `create_share_link` tool exactly as it holds for the
  button: `get_share_status` reports that a link exists and when, because only a digest was kept.
- One configured administrator exists; the demo is not a general role-management system.
- PNG/SVG export requires a browser DOM. There is no server image-rendering service, so
  `export_diagram` offers `json` and `scaffold` only and its description tells a calling model to
  send the user to the editor's own button for an image.
- Auto-layout is a convenience, not a semantic architecture validator.
- The catalog models Cloudflare products and common external actors; it is not infrastructure import
  or bidirectional IaC synchronization.

## Quality evidence

- Three Vitest projects cover client behaviour, pure Worker/application code, and the real Workers
  runtime with D1 migrations, Access outcomes and real hibernatable WebSockets.
- Istanbul includes all authored `src/**/*.{ts,tsx}` and enforces 80% statements, branches,
  functions and lines; the MCP layer is complete at 100% in every category.
- `pnpm check` regenerates binding types and verifies strict TypeScript, Oxfmt, type-aware Oxlint,
  naming safety, built CSS/bundle contracts and Terraform validation/formatting.
- The MCP surface is proved over the wire rather than through its functions: `tools/list` and
  `tools/call` round trips against the real handler, every tool in the catalogue exercised, the
  three authentication failures that matter (no credential, an audience belonging to another Access
  application in the same team, an expired token), and one named test asserting that a non-owner
  receives the identical non-enumerating `404` from HTTP and from MCP.
- A separate suite asserts that **nothing** the MCP surface logs carries a share token, graph
  content or an email address — across the whole catalogue in one pass, so a seventeenth tool added
  without that discipline fails it.
- The local browser pass covers desktop/narrow geometry, themes, modal focus, initial fit, keyboard
  connection and responsive drawers. It complements rather than duplicates DOM tests.
- One thing is deliberately not automated: the Managed OAuth round trip, which is an Access-edge
  feature with no local emulation. [`MCP-VALIDATION.md`](MCP-VALIDATION.md) is the re-runnable
  operator runbook for it.
