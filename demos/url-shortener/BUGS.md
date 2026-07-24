# Bugs

## Resolved

### 1. Local Access login was not shown

The shared Access policy no longer bypasses every unmatched path. Local navigation to `/` and `/admin` now enters the toolkit's Access login flow, management API requests return `401` instead of login HTML, and only `/l/*` is explicitly public.

### 2. The UI could render without Access

The browser bootstrap performs a document-level redirect from `/` to `/admin` before mounting Vue. This forces the request through the existing `/admin*` Access application and prevents an anonymous client-side router redirect from displaying the UI.

### 3. The create form wasted horizontal space

The create form now uses a compact responsive layout: the URL field and action are side by side from the small breakpoint upward and stack on narrow screens.

### 5. Client coverage was incomplete

Tests now cover browser bootstrap, Pinia CRUD and error behavior, Access path policies, component interactions, dialog behavior, and defensive error branches. The combined suite reports 100% statement, branch, function, and line coverage.

## Open For Design Discussion

### 4. A first deployment cannot attach the custom domain

Terraform currently attempts to attach the custom domain before Wrangler has created the Worker's first deployment, and Cloudflare rejects that ordering with error `100124`.

**Root cause:** `cloudflare_workers_custom_domain.demo` (`infra/main.tf`) depends only on the bare `cloudflare_worker.demo` service resource. Cloudflare's custom domain API requires the Worker to already have at least one deployment before a domain can attach. Terraform deliberately never manages ordinary Worker deployments (Wrangler owns those, per `AGENTS.md`), so on a brand-new Worker there is no deployment yet when Terraform tries to create the custom domain.

**Fix (per `docs/DECISIONS.md` #3):** add a one-time, Terraform-managed bootstrap deployment — a placeholder `cloudflare_worker_version` + `cloudflare_workers_deployment` created once (with `lifecycle { ignore_changes = all }`) purely to give the Worker its first deployment, with `cloudflare_workers_custom_domain.demo` depending on it. `wrangler deploy` immediately supersedes the placeholder with the real code on every deploy (Worker deployments are immutable historical records, so the placeholder is never revisited); Terraform never touches the bootstrap version/deployment again after creating it, and Wrangler remains the sole owner of every deployment from that point on. No `package.json` script changes are required — this is entirely a Terraform-side fix, and it is idempotent across repeated `npm run deploy` runs.

### 6. When I run `npm start` and log in, I get 404 Not Found

Url: <https://localhost:5173/admin>
Output: {"type":"about:blank","status":404,"title":"Not Found"}

**Root cause:** `wrangler.jsonc.tpl`'s `run_worker_first: ["/admin*", "/api/*", "/l/*"]` forces `/admin*` requests through the Worker (necessary so `cloudflareAccess` can gate it before any HTML is served), but `src/worker/index.ts` only mounts routers for `/api/links` and `/l` — there is no handler for `/admin`. An authenticated request to `/admin` is correctly let through by `cloudflareAccess` (which already blocks it pre-login via the implicit `defaultAction: "block"`), and then falls through Hono's router with no match, hitting `app.notFound()` — which produces exactly the reported RFC 9457 404. `/` is unaffected in production because it is not in `run_worker_first` and is served directly by the static-assets SPA fallback (`not_found_handling: "single-page-application"`).

The access-policy configuration in `src/access-policies.ts` is **not** the cause of the 404 — `/admin` is already correctly gated pre-login by the implicit `defaultAction`. The concrete fix is a Worker-side route/fallback that serves the `ASSETS` binding for `/admin*` once Access lets the request through, for example:

```ts
app.get(["/admin", "/admin/*"], (c) => c.env.ASSETS.fetch(c.req.raw));
```

Additionally, `accessPolicies` should gain an explicit `/admin` entry (`authenticate: true, redirect: true`) and `defaultAction: "block"` should be set explicitly in `src/worker/middleware/access.ts`, so the "authenticated everywhere except `/l/*`" intent is self-documenting rather than relying on an implicit default. This part of the fix is still under discussion and not yet implemented.
