# Architect — What This Demo Teaches

> This file describes Phase 1 (scaffolding and Access) of `docs/09-ARCHITECT.md`. It is the
> foundation for a Cloudflare architecture diagram editor ported from a real, working prior art
> application (CF-Architect); later phases add the catalog/editor, sharing, admin, and
> export/print/dark-mode capabilities the full plan describes.

## What This Demonstrates

- **A mixed public/authenticated hostname with two Cloudflare Access applications.** One
  hostname-wide `bypass` application covers the public landing page; a second, more specific
  `allow` application scoped to `/app*` and `/api/*` destinations requires any authenticated
  identity. Access evaluates the most specific matching application per request, so the two
  applications never conflict — see [Public Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/) in AGENTS.md for the general pattern this demo follows.
- **Independent, application-level admin authorization on top of Access.** `cloudflareAccess()`
  alone proves only that *some* valid identity from this Cloudflare Access team authenticated —
  every Access application in a team shares the same JWKS, so a token minted for a *different*
  application in the same team would also be accepted here (cross-application token replay).
  This demo pins the Access application's own audience (`aud`) tag as defense against that, and
  layers a second, independent comparison in `GET /api/me` against an operator-configured
  `ADMIN_EMAIL` value — there is no D1 role column, and exactly one identity is ever the
  administrator, set by the operator rather than by a first-user-wins bootstrap.
- **React as a deliberate, scenario-scoped exception to this repository's Vue default.** This
  port's UI is React because the real prior art (CF-Architect) and the diagram library it needs
  in Phase 2 (`@xyflow/react`) are both React; rewriting proven, working functionality in Vue
  first would be pure translation effort with no new teaching value. Phase 1 itself has no
  React-specific complexity yet — that arrives with the diagram canvas in Phase 2.
- **A lightweight identity directory that is explicitly never an authorization source.** Every
  authenticated request upserts a `users` row keyed on the verified email. The table exists
  solely to back a future read-only admin user directory (Phase 4) — no route ever reads it to
  decide what a request is allowed to do, which is why `upsertUserMiddleware` performs no
  authorization check of its own.

## How It Works

### Data model

`migrations/0001_create_diagrams_and_users.sql` creates both tables Phase 1 through Phase 4 need,
even though only `users` is written to yet:

```sql
CREATE TABLE diagrams (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  graph_data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  email TEXT PRIMARY KEY,
  display_name TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
```

`diagrams.owner_email` replaces CF-Architect's `owner_id` foreign key into its own `users` table
entirely, since the verified Access identity *is* the owner key — there is no separate internal
user identifier anywhere in this schema. `users.display_name` is always `NULL` today:
`cloudflareAccess()`'s verified identity (`src/worker/bindings.ts`) exposes only `email`, `sub`,
and `source` — no name claim — and this demo provisions no Identity Provider of its own that
could supply one (see "Dropped: a provisioned Identity Provider" below). Wrangler owns this
schema through `db:migrate:local`/`db:migrate:remote`; Terraform owns only the
`cloudflare_d1_database` resource itself.

### The two-application Access model

`infra/access.tf` provisions:

1. A `bypass` policy + application covering the whole hostname (`architect.cfapps.uk`) — the
   public landing page needs no Access challenge at all.
2. An `allow` policy (`include = [{ everyone = {} }]`, meaning any authenticated identity from a
   configured provider) + application scoped to `/app*` and `/api/*` destinations.

Because Access enforces both at the edge, `/app*` needs no server-side gate of its own — it is
served by the `ASSETS` binding's `single-page-application` fallback exactly like the public
landing page, and `wrangler.jsonc.tpl`'s `run_worker_first` lists only `/api/*`
(`src/worker/index.ts`). `src/access-policies.ts` defines one shared array of path policies
consumed by both `cloudflareAccess()` in the Worker (`src/worker/middleware/access.ts`) and, in
local development, `@adrianhall/cloudflare-toolkit/vite`'s `cloudflareAccessPlugin()`
(`vite.config.ts`) — the same array documents every path's access level in one place, with the
public catch-all deliberately listed last so a newly added protected path can never silently
inherit public access by omission.

`accessMiddleware` pins `audience` to the `/app*`+`/api/*` application's own AUD tag
(`infra/access.tf`'s `app` application, exposed as the `access_audience` Terraform output),
threaded in as a Vite build-time define (`VITE_ACCESS_AUDIENCE`) rather than a generated Worker
var — `cloudflareAccess()` reads `audience` once at Worker module-load time, before any
request-scoped `env` binding is available.

### Independent admin authorization

`GET /api/me` (`src/worker/routes/me.ts`) returns `{ email, isAdmin }` for **every** authenticated
identity — unlike `demos/url-shortener`'s admin-only `/api/me`, an ordinary user gets a `200`,
not a `403`. `isAdmin` is computed by one comparison, `identity.email === context.env.ADMIN_EMAIL`
— there is no D1 role column, no first-user-becomes-admin bootstrap, and no promote/demote
workflow. Exactly one identity is ever the administrator, and it is set by the operator through
`.env`/Terraform, not by the application. The client (`src/client/hooks/useIdentity.ts`) uses
`isAdmin` to conditionally render admin UI once Phase 4 adds it, without a separate round trip.

### Dropped: a provisioned Identity Provider

CF-Architect provisions a Terraform-managed GitHub Identity Provider. This port drops that
resource entirely: Access authentication relies on whichever Identity Provider(s) the target
account's Zero Trust team already has configured, exactly like every other demo in this
repository. That is also why `users.display_name` has no data source yet — GitHub's OAuth profile
was the only name source CF-Architect had, and this demo intentionally does not reintroduce a
GitHub-specific dependency to get one back.

### Observability

`cloudflareLogger()` provides request-scoped structured logging on every request.
`problemDetailsErrorHandler()`/`notFoundHandler()` give every error response — including an
unauthenticated `401` from `accessMiddleware` and a `404` for any unmounted API route — the same
RFC 9457 `application/problem+json` shape. Terraform enables Workers Logs at 100% sampling and
traces at 10% sampling on the Worker resource.

## Further Reading

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [D1](https://developers.cloudflare.com/d1/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Workers KV](https://developers.cloudflare.com/kv/)
- [Cloudflare Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Manage reusable Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/policy-management/)
- [Workers observability](https://developers.cloudflare.com/workers/observability/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [RFC 9457 — Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
- [Hono](https://hono.dev/docs/getting-started/cloudflare-workers)
- [React](https://react.dev/)
- [React Flow (`@xyflow/react`)](https://reactflow.dev/) — adopted starting Phase 2's diagram canvas.
- `spikes/06-architect-reactflow-host/REPORT.md` — this repository's Phase 0 spike confirming the plain Vite/React/Cloudflare host architecture.
