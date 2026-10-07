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

A later Durable Object layer will coordinate live sockets only; it will not persist another graph.
That narrow role avoids two independently durable copies silently disagreeing.

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

## Infrastructure ownership and lifecycle

Terraform owns resources with durable lifecycle: D1, KV, Worker registration/bootstrap, custom
hostname, DNS route and Access applications/policies. `cf` owns code upload and deploy-time
bindings. Neither creates the other's resources.

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

- This is Layer 1: one person's browser editor. MCP, collaboration, Durable Object live sync and AI
  assistance are later layers, not incomplete hidden routes.
- Whole-graph autosave is last-write-wins across simultaneous tabs. Granular ordered operations are
  introduced only with collaboration.
- One anonymous link per diagram is active at a time, read-only, and non-recoverable after its
  one-time disclosure.
- One configured administrator exists; the demo is not a general role-management system.
- PNG/SVG export requires a browser DOM. There is no server image-rendering service.
- Auto-layout is a convenience, not a semantic architecture validator.
- The catalog models Cloudflare products and common external actors; it is not infrastructure import
  or bidirectional IaC synchronization.

## Quality evidence

- Three Vitest projects cover client behaviour, pure Worker/application code, and the real Workers
  runtime with D1 migrations and Access outcomes.
- Istanbul includes all authored `src/**/*.{ts,tsx}` and enforces 80% statements, branches,
  functions and lines; Phase 7 records over 99% in every category.
- `pnpm check` regenerates binding types and verifies strict TypeScript, Oxfmt, type-aware Oxlint,
  naming safety, built CSS/bundle contracts and Terraform validation/formatting.
- The local browser pass covers desktop/narrow geometry, themes, modal focus, initial fit, keyboard
  connection and responsive drawers. It complements rather than duplicates DOM tests.
