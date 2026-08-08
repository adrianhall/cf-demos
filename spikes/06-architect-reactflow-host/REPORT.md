# Phase 0 Spike Report — React Flow in a plain Vite/React host

Run 2026-08-08, entirely local (`npm run start` / `vite dev`, no deployment — see `README.md` for
why this spike needed no Terraform or real Access application). Findings below are **live-verified**
(an actual request/response against the running `vite dev` server, captured with `curl` and cross-
checked against the Cloudflare Vite plugin's own Local Explorer observability API), **build-verified**
(`vite build`/`tsc --noEmit` actually run, output pasted below), or **source-verified** (read
directly from `~/repos/adrianhall/CF-Architect`'s real, working source, or from the installed
`@adrianhall/cloudflare-toolkit` package's shipped `dist/vite/index.js`). Each finding says which.

## 1. Exact dependency versions used

Pulled live from `npm view <pkg> version` at spike time, then pinned exactly (not `^`/`~`) in
`package.json`, matching this repository's existing spike convention:

| Package | Version |
| --- | --- |
| `react` / `react-dom` | `19.2.8` |
| `@types/react` / `@types/react-dom` | `19.2.18` / `19.2.4` |
| `@xyflow/react` | `12.11.2` |
| `@vitejs/plugin-react` | `6.0.5` |
| `@cloudflare/vite-plugin` | `1.51.1` |
| `vite` | `8.2.1` |
| `wrangler` | `4.120.0` |
| `hono` | `4.13.1` |
| `@adrianhall/cloudflare-toolkit` | `2.3.0` (same version `demos/url-shortener` already pins) |
| `typescript` | `^7.0.2` |

`@adrianhall/cloudflare-toolkit@2.3.0`'s own `peerDependencies` (`hono: ^4.12.28`,
`vite: ^8.1.4`, source-verified via `npm view`) are both satisfied by the versions above.
`@cloudflare/vite-plugin@1.51.1`'s peer range (`vite: ^6.1.0 || ^7.0.0 || ^8.0.0`,
`wrangler: ^4.120.0`) is also satisfied.

## 2. Build and type-check both succeed cleanly (build-verified)

```
$ npm run check:types
> tsc --noEmit
(no output — clean)

$ npm run build
> vite build
vite v8.2.1 building spike_06_architect_reactflow_host environment for production...
✓ 93 modules transformed.
dist/spike_06_architect_reactflow_host/index.js   145.64 kB │ gzip: 42.54 kB
✓ built in 19ms
vite v8.2.1 building client environment for production...
✓ 178 modules transformed.
dist/client/assets/index-*.css   17.20 kB │ gzip:  3.09 kB
dist/client/assets/index-*.js   375.15 kB │ gzip: 118.82 kB
✓ built in 63ms
```

Zero warnings or errors from either the Worker or client build environments (`@cloudflare/vite-
plugin` builds both from one `vite build` invocation, one environment each). `tsc --noEmit`
against a single `tsconfig.json` covering `DOM` + `WebWorker` libs together (this repository's
existing pattern — `demos/url-shortener/tsconfig.json`) type-checks React 19 JSX and the Worker's
Hono code with no conflicts.

**Bundle-size checkpoint for Phase 5's ELK decision:** the base editor bundle — React 19 +
`@xyflow/react` + this probe's own code, no auto-layout library yet — is **118.82 kB gzip**. This
is far under the 539.52 kB gzip figure that made this repository's prior Vue attempt at this same
demo defer ELK to a lazy `import()` (docs/09-ARCHITECT.md's porting table). Confirms that
decision's premise still holds for the React port: the base bundle has plenty of headroom before
ELK is even added, so Phase 5 lazy-loading it remains the right call, not a bundle-size
must-have that's already been eaten by the host architecture itself.

## 3. `cloudflareAccessPlugin()` coexists cleanly with `@cloudflare/vite-plugin` + `@vitejs/plugin-react` (live-verified)

Full login → authenticated API call → get-identity → logout round trip, driven entirely over
`curl` against the real running `vite dev` server (no mocking):

```
$ curl -sI -H "Sec-Fetch-Mode: navigate" http://localhost:5173/
HTTP/1.1 302 Found
Location: http://localhost:5173/cdn-cgi/access/login?redirect=%2F

$ curl -s http://localhost:5173/api/whoami
{"type":"about:blank","status":401,"title":"Unauthorized","detail":"Authentication required"}

$ curl -s -c cookies.txt -o /dev/null -X POST http://localhost:5173/cdn-cgi/access/login \
    --data "email=presenter@example.com&redirect=%2F"
$ curl -s -b cookies.txt http://localhost:5173/api/whoami
{"email":"presenter@example.com"}
$ curl -s -b cookies.txt http://localhost:5173/cdn-cgi/access/get-identity
{"id":"...","name":"Presenter","email":"presenter@example.com", ...}
$ curl -sI -b cookies.txt http://localhost:5173/cdn-cgi/access/logout
HTTP/1.1 302 Found
Location: http://localhost:5173/
# subsequent request with the same (now-cleared) cookie jar is unauthenticated again
```

The Worker's own `cloudflareAccess()` middleware and the Vite plugin's dev emulation agree on
every path in `src/access-policies.ts`, reused verbatim by both, exactly as
`demos/url-shortener` already does — no separate dev-only auth code was needed anywhere.
`@cloudflare/vite-plugin`'s Local Explorer observability API
(`/cdn-cgi/local/explorer/api/local/observability/query`) was queried directly against its
captured `spans`/`logs` tables after the full probe session above plus the manual browser session
described in Section 5: every dispatched request shows `outcome: "ok"`, `error: null` — zero
Worker-side errors across the whole session.

**Non-obvious finding — an API path policy MUST set `redirect: false` explicitly, or the dev
plugin can redirect an API caller to the login page instead of returning JSON.** This spike's
first draft of `access-policies.ts` used bare `{ pattern: /^\/api\//u, authenticate: true }` with
no `redirect` field. Reading `@adrianhall/cloudflare-toolkit`'s shipped
`dist/vite/index.js` (source-verified) shows the plugin's request handler:

```js
if (policyMatch?.authenticate === true && policyMatch.redirect === false)
  return sendJson(res, 401, { error: "Authentication required" });
if (isNavigation(req)) return redirectToLogin(res, loginPath, pathname);
return next();
```

`isNavigation()` treats a request as a browser page navigation whenever it carries
`Sec-Fetch-Mode: navigate`, **or**, failing that, an `Accept` header containing `text/html` — not
based on the request path at all. A bare `curl http://localhost:5173/api/whoami` (default
`Accept: */*`) is correctly treated as an API call and falls through to the Worker's own 401. But
`curl -H "Accept: text/html" http://localhost:5173/api/whoami` — or a real browser navigated
directly to that URL by pasting it into the address bar — gets a `302` redirect to the login page
instead of the `401` an API client expects, live-confirmed both ways during this spike. Setting
`redirect: false` on the `/api/` policy entry (this spike's final `access-policies.ts`) makes the
JSON 401 unconditional regardless of how "browser-like" the request looks. This is exactly why
`demos/url-shortener/src/access-policies.ts` already sets `redirect: false` on `/api/links` and
`/api/me` — Phase 1 of docs/09-ARCHITECT.md should copy that pattern deliberately, not by
accident: **every `/api/*` policy entry needs an explicit `redirect: false`.**

## 4. No Astro-specific behavior needed reproducing (source-verified against the real CF-Architect repo)

Read `~/repos/adrianhall/CF-Architect/src/middleware.ts` directly: its entire responsibility is
(a) pattern-matching protected paths, (b) calling a hand-rolled `cloudflareAccessAuth.resolveUser()`
JWT verifier, (c) a `DEV_MODE` mock-user bypass, and (d) a second admin-route check. All four are
already the intended replacement targets named in docs/09-ARCHITECT.md's Terraform And Toolkit Gap
Analysis (`cloudflareAccess()` + `cloudflareAccessPlugin()` for (a)–(c), the `ADMIN_EMAIL`
middleware for (d)) — nothing else is hiding in that file.

**The editor page specifically already opts out of Astro SSR.**
`~/repos/adrianhall/CF-Architect/src/pages/diagram/[id].astro` mounts its React Flow island with
`client:only="react"` (not `client:load`), meaning Astro never server-renders the editor at all —
it ships an empty placeholder and the island hydrates from scratch client-side, identically in
spirit to this spike's `createRoot(container).render(<App />)` in `main.tsx`. The single most
Astro-coupled-looking page in the whole app turns out to already behave like a plain client-
rendered SPA. The dashboard/blueprints/admin pages (`client:load`) do get a real SSR-rendered
initial DOM before hydration — a plain Vite SPA has none (just `<div id="root">` until JS runs) —
but that is a perceived-first-paint difference, not a functional one, and every other demo in
this repository already accepts a plain client-rendered SPA with no SSR fallback.

**One real, load-bearing thing Astro did that this probe's single-page scope never needed, but
Phase 2 will:** `Astro.params` gives the editor page its `:id` route parameter server-side, passed
into the `client:only` island as an ordinary React prop
(`~/repos/adrianhall/CF-Architect/src/islands/DiagramCanvasWrapper.tsx`). A plain Vite/React SPA
has no server-side router at all — every route is resolved client-side — so Phase 2's editor route
needs its own client-side way to read `diagramId` out of the URL (a small client-side router, or
manual `window.location.pathname` parsing) that CF-Architect's file-based Astro routing gave it
for free. This is a real, if easily-addressed, migration detail Phase 2 should account for
explicitly rather than discover mid-phase.

**Conclusion for the doc's required decision:** no, Astro added nothing load-bearing this plain
Vite/React/Cloudflare setup needs to reproduce for the five capabilities this probe targeted
(catalog nodes, an actor node, two edge types, editable properties, a read-only toggle) — the one
genuine gap found (route-param threading) is a routing concern for Phase 2's multi-page app, not
a property of the diagram canvas itself, and is a normal, well-understood addition (a client-side
router), not a surprise.

## 5. `@xyflow/react` custom nodes/edges/palette/read-only mode — wiring confirmed, interaction confirmed by code+DOM inspection, not by an automated real-browser click-test

This spike's probe (`src/client/App.tsx`) implements, and `vite build`/`tsc --noEmit` confirm
compile cleanly against React 19: five product nodes + one actor node (`nodeTypes: { product,
actor }`), two custom edge types (`edgeTypes: { http, binding }`) rendered via `BaseEdge`/
`EdgeLabelRenderer`/`getBezierPath` exactly as `@xyflow/react`'s own docs describe, an
HTML5-drag-and-drop palette (`dataTransfer` + `screenToFlowPosition` on drop, the same mechanism
CF-Architect's own `ServicePalette`/`DiagramCanvas` pair uses, confirmed by reading
`~/repos/adrianhall/CF-Architect/src/islands/DiagramCanvas.tsx`), an editable properties panel
bound to `onSelectionChange`, and a read-only toggle that sets `nodesDraggable`/`nodesConnectable`
to `false` while leaving `elementsSelectable` `true` — **the exact same three-prop combination**
CF-Architect's own `DiagramCanvas.tsx` uses for its read-only share viewer (source-verified,
`grep`'d directly: `nodesDraggable={!readOnly}`, `nodesConnectable={!readOnly}`,
`elementsSelectable={true}` unconditionally).

Live-verified via `vite dev` + the Local Explorer's captured spans: the client bundle loads, the
Worker never errors, and requesting the transformed `src/client/App.tsx`/`main.tsx` modules
directly over HTTP shows Vite correctly resolving and pre-bundling `react`, `react-dom`, and
`@xyflow/react` with no missing-dependency or resolution errors.

**What this spike could not verify, and why:** this environment has no browser-automation tool
available (no Chrome DevTools MCP, no Playwright — and AGENTS.md/the Spike Conventions
deliberately steer away from adding Playwright to this repository regardless). Real
pointer-based/HTML5-drag-and-drop interaction (dragging a palette entry onto the canvas, dragging
a node, dragging a connection between two handles) genuinely needs a real browser's pointer-event
and `dataTransfer` implementation — `jsdom` does not implement drag-and-drop or real layout
geometry meaningfully enough to make a headless DOM test of this behavior trustworthy, and
`docs/06-AGENTIC-CHAT.md`'s Spike Conventions explicitly say not to write a mocked test asserting
an assumption in place of actually exercising the real thing. **Recommendation: the first thing
done at the start of Phase 1 should be a two-minute manual click-test of this exact spike in a
real browser** (drag a product onto the canvas, drag a connection, toggle read-only, confirm
dragging is disabled) before building the real editor on top of this confirmed host architecture
— cheap insurance for the one dimension this report can't close out itself. Given `@xyflow/react`
is unmodified from its published form (no patches, no wrapper library shimming its DOM event
handling) and is already proven interactive inside CF-Architect's own Astro islands, there is no
structural reason specific to this host (Vite + `@cloudflare/vite-plugin` + `@vitejs/plugin-react`
vs. Astro) to expect different pointer-event behavior — but "no structural reason to expect a
difference" is a code-review-level claim, not the same strength of evidence as this report's other
live-verified findings, so it is called out at this weaker confidence level deliberately.

**One deliberate deviation from CF-Architect worth flagging, not a bug:** CF-Architect's
`PropertiesPanel` is hidden entirely in read-only mode
(`{!readOnly && !printMode && <PropertiesPanel />}`); this probe's `PropertiesPanel.tsx` instead
stays mounted and renders the selected node's label/description as plain text. Both are valid
"true read-only mode" implementations of the same underlying `nodesDraggable`/`nodesConnectable`/
`elementsSelectable` combination the probe was scoped to test — this spike's choice was made to
exercise a second render path (read-only branch of a still-mounted component) rather than to
prescribe Phase 3's real share-viewer UI, which is free to hide the panel outright like the
original if that reads better for that page.

## Summary — answers to docs/09-ARCHITECT.md's required Phase 0 outcomes

1. **Whether Astro added anything load-bearing:** No, for the diagram canvas itself (Section 4).
   One real, minor addition Phase 2 needs that Astro's file-based routing gave CF-Architect for
   free: a client-side way to read `diagramId` out of the URL.
2. **Final dependency versions:** confirmed and pinned exactly (Section 1); all peer-dependency
   ranges satisfied.
3. **`cloudflareAccessPlugin()` coexistence:** confirmed clean, full login/logout round trip
   live-verified (Section 3), with one concrete, reusable policy-authoring rule surfaced for
   Phase 1: every `/api/*` policy entry needs an explicit `redirect: false`.
4. **React Flow specifics (nodes/edges/palette/read-only):** wiring, types, and build all
   confirmed; real pointer-interaction fidelity is inferred from code-level parity with
   CF-Architect's own working implementation rather than an automated real-browser test — flagged
   as a cheap manual check to do first in Phase 1, not a blocker to starting it.
