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

## Browser capture, pure SVG and print are separate contracts

The editor's PNG/SVG export captures the actual React Flow DOM using graph bounds and a fitted
transform, so the file is independent of the current viewport. This cannot be reproduced faithfully
in the Worker: browser fonts, computed styles, theme and product-icon DOM are not part of the stored
graph. Print mode similarly manipulates page layout, colour scheme and the native print dialog, then
restores every change after print/cancel/unmount.

That does not mean a Worker cannot produce SVG. `graph-svg.ts` is a pure domain transform over
canonical `GraphData`: it computes its viewBox from node extents, draws labelled catalogue-coloured
shapes at the stored coordinates, and renders edge colour, dash style, arrowhead and label from the
same catalogue the React Flow renderer uses. It is a vector description, not a DOM screenshot. The
distinction is why server-side SVG is possible while PNG remains browser-only, and why the output
optimises for a correct, legible architecture rather than pixel fidelity to one open tab.

Product export is another pure graph transform and produces a ZIP starter. The one deliberate source
deviation is that this port generates typed `cf/config` and `cf` commands instead of the source
demo's obsolete Wrangler scaffold. That change teaches the repository's current control plane rather
than preserving retired deployment mechanics.

The `export_diagram` MCP tool therefore offers `json`, `svg` and `scaffold`. SVG is returned as text
so an agent can write it verbatim into a repository and embed it in Markdown; the Worker imports the
**same** `generateScaffold` as the toolbar and returns that ZIP as base64, so both surfaces hand a
reader byte-identical projects. PNG remains out because pixels need a renderer. The tool's own
description states all three facts rather than leaving a model to infer them from a failed call.

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
than the editor's own layered layout, `export_diagram` says SVG works while PNG is browser-only, and
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

## One serialized write path, and why the platform is the mechanism

Three writers reach a diagram's graph: the browser, which replaces the whole graph on a 500 ms
debounce; the REST route behind it; and the owner's own agent, applying one granular operation per
tool call. Until the collaboration work they each wrote to D1 independently, and three writers each
reading a row, changing it and writing it back is a lost update that no amount of care at any one
call site prevents - the second writer never saw the first.

Every write now goes through one `DiagramSession`, the Durable Object for that diagram, and the
correctness comes from the execution model rather than from an algorithm:

- **A synchronous mutation cannot be interleaved.** A Durable Object is single-threaded, there is
  exactly one instance per diagram id, and the input gate holds incoming events while synchronous
  JavaScript runs. The session reads its working graph, computes the replacement and installs it
  with no `await` in between, so two concurrent operations are applied one after the other rather
  than both against the same starting graph. The gate opens at the first `await`, which is intended:
  a later edit is accepted while an earlier write is still in flight.
- **Persists are strictly ordered**, through a small write queue. Without it a slow earlier write
  lands after a faster later one and silently restores the older graph. That is not hypothetical -
  the Phase 16 spike reproduced it, and `tests/worker/write-queue.test.ts` still runs the same
  scenario with and without the queue, so the test fails against an unqueued implementation rather
  than passing against anything.

**There is no CRDT, no operational transform and no version vector here, deliberately.** The point
of this part of the demo is that a Durable Object's execution model already provides what those
would otherwise be reached for, when the coordination is per-entity and the writes carry whole
state.

Two honest qualifications, because overstating this is easy:

- **The guarantee is about the final value.** Reading the working graph when a queued write's turn
  arrives coalesces later writes toward current state, but it cannot retroactively change a write
  already in flight - so an observer watching D1 mid-sequence can still see an intermediate graph.
  The last value is the one that was applied last.
- **Conflict resolution is still last-applied-wins.** Two changes to the same element leave one
  winner, decided by the order the session applied them rather than by any client's clock. What has
  changed is that nothing is lost _unseen_: a change to a different element now always survives.

Writes are **persisted before they are broadcast**. The source design for this feature broadcast
first, for latency; this port inverts that, because broadcasting first lets a connected editor
render a change that a reload would not show. Persisting first can at worst lose a broadcast, and
the change is still in D1 for the next read.

When a push is applied, a dismissible "Updated by an agent" notice explains why the canvas changed.
A diagram that rewrites itself with no explanation reads as a bug rather than as the feature it is.

## The channel carries operations, not graphs

The live channel is two-way: a client may send an operation, and the session answers every one with
an acceptance broadcast to everybody or a rejection to the originator alone.

What travels is the **operation** rather than the resulting graph, and that choice is the whole
reason a second person's edit is tolerable. Applying "add this node" leaves whatever the recipient
is halfway through typing; replacing their graph discards it. With two people editing, that is the
difference between collaborating and taking turns. It also lets the interface say what happened,
which "the graph changed" cannot.

The cost is that a recipient must apply every operation, in order, or diverge from what is stored —
and that divergence is silent, which makes it the characteristic failure of this design. So each
frame carries a sequence number, each one exactly one more than the last, and a client that sees a
gap asks for a fresh snapshot instead of guessing. A brief flicker beats a canvas that quietly
disagrees with the database.

Three smaller decisions follow from the same concern:

- **Attribution comes from the socket, never from the frame.** The protocol has no author field at
  all, and a payload that invents one is refused rather than stripped — stripping would leave the
  protocol looking as though it might one day honour it.
- **Each frame carries an origin**, distinguishing a person from an agent. The identity cannot do
  it: an agent authenticates as whoever configured it, so "alice@example.com changed this" is true
  of both, and the one thing a user most needs to know about a change they did not make would be
  unsayable.
- **A rejection goes to the originator alone.** Two people deleting the same node is the ordinary
  shape of collaboration rather than a bug, and telling everybody else would name an element they
  may be editing quite happily. The connection stays open: a race must not cost anybody a session.

## The browser dispatches operations on its existing debounce

The browser's controls still know nothing about transport. Every edit goes through the Zustand store
as it did before collaboration, and after the existing 500 ms of quiet one pure diff compares the
last graph dispatched with the optimistic canvas. The resulting ordered operations cover drag, add,
connect, properties, delete, undo/redo and auto-layout through one seam, instead of every control
growing its own socket call. The user therefore gets one batch after a burst rather than a frame per
keystroke or pointer move.

Each operation has a client id. The originator applies its edit optimistically, matches the server's
echo to that id, and advances the stream without applying the edit twice. Remote operations are
applied to the confirmed graph first, then pending and unsent local operations are replayed over it
in order; that is what preserves both sides when the network interleaves them. A rejection requests
a snapshot rather than trying to infer which optimistic fields to undo.

The whole-graph REST save remains a resilience fallback while the socket is not connected. The two
paths are mutually exclusive at each debounce, so reconnecting cannot create a second writer.

## Presence is a projection, not document state

The same live session carries a second, intentionally weaker class of frame: presence snapshots and
join/leave events, plus throttled cursor and selection updates. The session derives participants
from `ctx.getWebSockets()` and the verified identity/colour serialized on each socket attachment.
That makes a reconstructed Durable Object able to rebuild awareness after hibernation without a
presence map in D1 or Durable Object storage.

The browser sends cursor coordinates at most 15 times per second, and the session relays them only
to other tabs. These frames never hydrate the graph, enter the ordered write queue, increment the
sequence or touch D1: a missed cursor is replaced by the next movement, while a missed operation
requires a snapshot. The toolbar avatar stack and React Flow viewport overlay render this transient
projection outside the Zustand graph, which prevents a whole-graph REST fallback from accidentally
persisting it. Selection markers are advisory — an outline or connection midpoint says what someone
is currently looking at; it does not lock that element or change conflict resolution.

## Deliberate limitations

- Presence represents currently connected identities, not an audit trail, typing indicator, cursor
  history or lock. A disconnected socket immediately removes its participant and markers; a
  hibernated session can reconstruct only what live sockets still carry.
- Conflicts resolve last-applied-wins — between simultaneous tabs, between collaborators, and
  between a user and their own agent. Every write is serialized through the diagram's session, so
  nothing is overwritten unseen, but two changes to the same element still leave one winner; see
  "One serialized write path" above.
- Server-side auto-layout is a deterministic grid, not ELK, because ELK cannot run in `workerd`. The
  `auto_layout_diagram` tool description says so plainly, so a calling model does not promise a user
  the editor-quality layout it will not get.
- One anonymous link per diagram is active at a time, read-only, and non-recoverable after its
  one-time disclosure. That holds for the `create_share_link` tool exactly as it holds for the
  button: `get_share_status` reports that a link exists and when, because only a digest was kept.
- One configured administrator exists; the demo is not a general role-management system.
- Pixel-faithful browser capture and PNG require a DOM and renderer. `export_diagram` instead offers
  a pure graph-derived SVG alongside `json` and `scaffold`; its description sends a user to the
  editor only when they specifically need PNG or the live canvas's exact appearance.
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
