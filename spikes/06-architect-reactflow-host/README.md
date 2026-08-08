# Spike — `@xyflow/react` in a plain Vite/React host (no Astro)

**Aim** (docs/09-ARCHITECT.md, Phase 0): prove whether `@xyflow/react`, its custom node/edge
renderers, palette drag-and-drop, and a true read-only mode behave the same wired directly into
`@cloudflare/vite-plugin` + a plain React SPA as they do inside CF-Architect's Astro-island
architecture, and whether `cloudflareAccessPlugin()` coexists cleanly with that setup. See
`REPORT.md` for what running it actually showed.

This is disposable spike code (AGENTS.md is not fully in force here; see
`docs/06-AGENTIC-CHAT.md`, Section 8 — "Spike Conventions", which this repository's other spikes
already follow). It is exempt from the demo contract (no custom domain, no
`DEMO.md`/`EXPLAIN-DEMO.md`, no three-Vitest-project structure).

## Why this spike stays entirely local — no Terraform, no Access application

This spike never exposes an inbound HTTPS endpoint on the real Cloudflare network — it only ever
runs under `vite dev`, gated locally by `cloudflareAccessPlugin()`. Per the Spike Conventions
section's first bullet ("a spike that never exposes an inbound HTTPS endpoint... needs neither
Terraform nor an Access application"), this spike needed no real-account footprint at all, and so
there is nothing to tear down.

## Drive it

```bash
npm install
npm run generate:types   # wrangler types, via the toolkit's generate-wrangler-types CLI
npm run start            # vite dev — serves the SPA and the Worker's /api/* routes together

# In another terminal — unauthenticated page load redirects to the local dev login form
# (only recognized as a "navigation" with a browser-shaped Accept/Sec-Fetch-Mode header;
# see REPORT.md):
curl -sI -H "Sec-Fetch-Mode: navigate" http://localhost:5173/

# Unauthenticated API call gets a real JSON 401, not a redirect:
curl -s http://localhost:5173/api/whoami

# Log in as one of vite.config.ts's two seeded identities, then re-request both:
curl -s -c /tmp/cookies.txt -o /dev/null -X POST http://localhost:5173/cdn-cgi/access/login \
  --data "email=presenter@example.com&redirect=%2F"
curl -s -b /tmp/cookies.txt http://localhost:5173/api/whoami
curl -s -b /tmp/cookies.txt http://localhost:5173/cdn-cgi/access/get-identity
curl -sI -b /tmp/cookies.txt http://localhost:5173/cdn-cgi/access/logout
```

Or open `http://localhost:5173/` in a real browser: it redirects to the dev login form, offers
the two seeded identities, and — once signed in — renders the probe canvas (five product nodes,
one actor node, two edge types, a draggable palette, a properties panel, and a "Read-only mode"
toggle in the toolbar). An unconditional "Log out" link in the toolbar always navigates to
`/cdn-cgi/access/logout`, matching AGENTS.md's Public Access requirement.

```bash
npm run check:types   # tsc --noEmit
npm run build          # vite build — builds both the Worker and the client SPA
```

## Files

- `src/access-policies.ts` — the one `PathPolicy[]` array shared by the Worker's
  `cloudflareAccess()` and `vite.config.ts`'s `cloudflareAccessPlugin()`, exactly like every real
  demo in this repository.
- `src/worker/index.ts` — a minimal Hono app: `cloudflareLogger()`, `cloudflareAccess()`, one
  protected `GET /api/whoami` route, and the toolkit's RFC 9457 error/not-found handlers.
- `src/client/App.tsx` — the probe's root component: the read-only toggle, the `/api/whoami` call
  button, the logout link, and the `@xyflow/react` canvas.
- `src/client/catalog.ts` — five Cloudflare products plus the one external actor the probe calls
  for; a deliberately tiny slice of CF-Architect's real ~30-product catalog.
- `src/client/nodes/ProductNode.tsx` / `ActorNode.tsx` — custom node renderers structurally close
  to CF-Architect's own `CFNode`.
- `src/client/edges/HttpEdge.tsx` / `BindingEdge.tsx` — the two probed edge types (a solid HTTPS
  call, a dashed Wrangler binding).
- `src/client/Palette.tsx` — the draggable product/actor palette; returns `null` entirely in
  read-only mode, matching CF-Architect's `ServicePalette` disposition.
- `src/client/PropertiesPanel.tsx` — editable label/description form for the selected node; in
  read-only mode, renders the same fields as plain text instead of hiding entirely (see
  `REPORT.md` for why this differs slightly from CF-Architect's own choice to hide the panel
  outright).

## What this spike does not do

No D1, no KV, no admin, no sharing, no export/print/dark-mode, no product search, no undo/redo, no
autosave, no ELK auto-layout, and no client-side router (`diagramId` in the real demo will come
from a route param — this probe is a single page, so it never needed one; see `REPORT.md`). Those
are later phases (docs/09-ARCHITECT.md, Phases 1–5), not this narrow hosting-architecture
question.
