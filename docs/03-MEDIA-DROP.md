# Demo 3: Media Drop

Directory: `demos/media-drop`

Domain: `media.cfapps.uk`

Cloudflare products: Workers, Static Assets, Cloudflare Access, D1, and R2.

## Behavior

- Provide a public library page that lists **published** media and lets anyone
  view an item's metadata, stream it, and download it — no sign-in required.
- Provide an authenticated **studio** section where a signed-in creator can
  upload a new image, audio file, or short video as an unpublished draft, list
  their own drafts and published items, publish a draft, and delete an item.
- Store the object **bytes** in R2 and the object **metadata** (title, owner,
  content type, size, status, timestamps) in D1, keeping content and metadata
  strictly separate.
- Serve draft (unpublished) content only to its authenticated owner through the
  Worker; serve published content to everyone.
- Write informational structured logs for upload, publish, download, and delete.

This is the curriculum's introduction to **R2**. The one new lesson is object
storage: uploading large objects without treating them as database rows,
listing/downloading/deleting them, and serving private objects through an
authorized Worker. D1 (from Demo 2) is reused only to hold the metadata that
must not live inside the object, and Cloudflare Access (from Demo 2) is reused
to add the demo's one twist — **optional** authentication: a public library plus
an authenticated studio on the same hostname.

## Demo Flow

1. As an anonymous visitor, open `https://media.cfapps.uk/` and see the public
   library. Note that Studio is not available.
2. Click the sign in and note Studio is now available.  Click on Studio to enter
   the authenticated section.
3. Click on "Upload media" to upload an image, audio file, or short video; it
   appears as an **unpublished draft** visible only to you. Confirm an anonymous
   browser cannot see it or download its content.
4. Publish the draft. Confirm it now appears in the public library.
5. As an anonymous visitor, open the published item, view its metadata, stream
   it, and download it.
6. Back in the studio, delete the item. Confirm it disappears from the library
   and that both the R2 object and the D1 row are gone (via the R2 and D1
   consoles).
7. Open Workers Logs and locate the `media_uploaded`, `media_published`,
   `media_downloaded`, and `media_deleted` events.

## Relevant Skills

**Cloudflare / backend skills:**

- `cloudflare`
- `cloudflare-one`
- `cloudflare-terraform-best-practices`
- `cloudflare-deploy-scripts`
- `cloudflare-toolkit`
- `workers-best-practices`
- `wrangler`

**Vue / UI skills:**

- `vue-best-practices`
- `vue-pinia-best-practices`
- `vue-router-best-practices`
- `vue-testing-best-practices`
- `web-perf`

Skills do not replace current documentation. Retrieve current Cloudflare docs,
the pinned Terraform provider schema, Workers types, the R2 Workers API
reference, and the Wrangler schema before relying on fields, limits, APIs, or
command options.

## Access Model

The whole demo lives on one hostname but has two audiences, so it uses the
mixed public/authenticated pattern from `demos/url-shortener` (a hostname-wide
public bypass application plus a narrower authenticated application), combined
with the any-authenticated-user, per-owner data isolation from
`demos/todo-app`.

- **Public bypass application** (hostname-wide): covers the library page, static
  assets, and the read-only public API. Bypassed traffic gets **no** Access JWT,
  so `cloudflareAccess()` must never require or validate a token on these routes.
  As in the canonical `demos/url-shortener`, this is expressed by marking the
  public paths `authenticate: false` in the shared `accessPolicies` array
  (`src/access-policies.ts`), **not** by removing or relocating the middleware:
  `cloudflareAccess()` is still mounted once globally, and the policy array is
  what decides which paths demand a verified identity.
- **Authenticated application** (more specific): an `allow` policy for any
  authenticated user (`everyone`), scoped with explicit `destinations` for every
  protected path prefix on the hostname — `/studio*`, `/api/studio*`. This
  application issues the identity JWT the studio API verifies.

Route namespaces make the boundary obvious and keep private and public traffic
on distinct path prefixes (required because bypassed public paths never receive
a JWT):

- Public, read-only, **published items only**:
  - `GET /api/library` — list published media.
  - `GET /api/library/:id` — published item metadata.
  - `GET /api/library/:id/content` — stream/download a published object
    (supports range and conditional requests).
- Authenticated, owner-scoped management:
  - `GET /api/studio/media` — list the caller's own drafts and published items.
  - `POST /api/studio/media` — upload a new draft (streams the request body to
    R2).
  - `GET /api/studio/media/:id` — the caller's item metadata.
  - `GET /api/studio/media/:id/content` — stream the caller's own object,
    including drafts (this is the "serve private media through an authorized
    Worker" lesson).
  - `POST /api/studio/media/:id/publish` — publish the caller's draft.
  - `DELETE /api/studio/media/:id` — delete the caller's object **and** its
    metadata.
  - `GET /api/studio/me` — the verified identity, for the studio UI.

Following `demos/todo-app`, this multi-user demo deliberately does **not**
validate the Access `audience`; it derives the owner identity from the verified
Access identity on every studio request and scopes every D1 query and R2 key to
that owner, so one signed-in creator can never read, publish, or delete another
creator's media. Because any authenticated user is a legitimate creator, no
per-email allowlist (the `requireAdmin` check in `demos/url-shortener`) is
needed; the owner-scoping is the isolation boundary.

## Implementation Plan

### Phase 1 — Scaffold and shared infrastructure

1. Create an independent `demos/media-drop` demo using Vue 3, Vuetify, Pinia,
   Vue Router, Vite, Hono, and TypeScript, following the canonical
   `demos/url-shortener` layout (`infra/`, `src/worker/`, `src/client/`,
   `tests/integration/`, `.env.example`, `README.md`, `DEMO.md`, `biome.json`,
   `tsconfig.json`, `vite.config.ts`, root `vitest.config.ts`).
2. Provision the baseline resources with Terraform: a Worker, the
   `media.cfapps.uk` custom domain (with the one-time inert bootstrap
   version/deployment so `cloudflare_workers_custom_domain` can attach without
   error `100124`), Workers Logs, and automatic tracing with explicit sampling.
   Read all configuration from `../.env` via the `dotenv` provider; set
   `DEMO_NAME=media` and `DEMO_DOMAIN=cfapps.uk`.
3. Provision a D1 database (for metadata) and an R2 bucket (for object bytes)
   with Terraform, and export their binding details as Terraform outputs
   (`d1_database_id`, `d1_database_name`, `r2_bucket_name`, plus `worker_name`,
   `hostname`, `environment`). Terraform owns both resources; Wrangler owns D1
   schema migrations and all Worker deployments.
4. Commit a single `wrangler.jsonc.tpl` with `{{placeholder}}` markers for every
   Terraform-sourced value (Worker name, D1 database id/name, R2 bucket name,
   `ENVIRONMENT`). Bind D1 as `DB` (with `migrations_dir`), R2 as `MEDIA`, and
   configure `assets` with `not_found_handling: single-page-application` and
   `run_worker_first: ["/api/*"]`. Add a committed `infra/local-outputs.json`
   with hardcoded local values (including a local R2 bucket name); running
   `generate-wrangler -c -l infra/local-outputs.json` fails fast if any
   `{{marker}}` has no matching key. Wire it into `prebuild`, `prestart`, and
   `precheck:types` as `run-s generate:wrangler:local generate:types`.
   Generate binding types from `wrangler.jsonc`; never
   hand-maintain the binding interface. Commit a `.dev.vars` (no secrets) that
   sets a local `ENVIRONMENT`.

### Phase 2 — Cloudflare Access (optional authentication)

5. Provision two Access applications with Terraform, following
   `demos/url-shortener`:
   - A hostname-wide **public bypass** application (a reusable `bypass` policy
     with `everyone`) so the library, static assets, and `/api/library/*` are
     fully public.
   - A more-specific **authenticated** application with an `allow` policy for
     any authenticated user (`everyone`), whose `destinations` explicitly list
     `/studio*` and `/api/studio*`. Access routes each request to the most
     specific matching application, so the bypass application still covers
     everything these destinations do not — no third "everything else" policy is
     needed.
6. Mount `cloudflareAccess()` **once, globally** in `src/worker/index.ts`, as
   `demos/url-shortener` does (`app.use(accessMiddleware)`), and let the shared
   `accessPolicies` array (step 7) decide per path whether a verified identity is
   required. Mark `/api/library/*` and the public page routes `authenticate:
   false` so bypassed traffic — which carries no JWT — is never asked to present
   or validate one, while `/api/studio/*` requires a verified identity. Do
   **not** try to protect the studio routes by mounting the middleware only on
   that prefix; keep the middleware global and drive the distinction from the
   policy array. Following `demos/todo-app`, do **not** validate the audience;
   derive the caller's stable identity (email) from the verified Access identity
   on every request — never from client-supplied input.
7. Add `src/access-policies.ts` exporting the shared path-policy array used by
   both the Worker middleware and the local Vite plugin:
   `/api/studio*` → `authenticate: true, redirect: false`; `/studio*` →
   `authenticate: true, redirect: true`; a final catch-all `/` →
   `authenticate: false` (public library, `/api/library*`, and detail pages).
8. Configure the toolkit's development-only `cloudflareAccessPlugin()` in
   `vite.config.ts` before `cloudflare()`, passing the same path-policy array.
   Provide selectable dev `users` matching `.env.example` defaults so local
   sign-in is one click, and enable development tokens only behind
   `import.meta.env.DEV`. Render an unconditional logout control that navigates
   to `/cdn-cgi/access/logout`, so signing in as the wrong identity during local
   development is recoverable.

### Phase 3 — Data model, R2, and API

9. Define the D1 schema as a Wrangler migration: a `media` table keyed by an
   immutable UUID with `owner` (the verified identity email), `title`,
   `content_type`, `size_bytes`, `r2_key`, `status` (`draft` | `published`),
   `created_at`, `updated_at`, and `published_at` columns. Index on
   `(status, created_at)` for the public library listing and on
   `(owner, created_at)` for the studio listing. Run migrations through Wrangler
   with the atomic `db:migrate:remote` / `db:migrate:local` scripts (each setting
   `CI=1`, targeting the `DB` binding, and stating `--remote`/`--local`
   explicitly).
10. Implement the media domain as separate files under `src/worker/media/`: an
    R2 storage helper (put/get/delete keyed by a per-owner `r2_key` such as
    `media/<owner-hash>/<id>`), a D1 metadata repository, input validation
    (title, allowed content types, max size), and shared types. Keep object
    bytes out of D1 entirely; D1 stores only the metadata and the `r2_key`
    pointer.
11. Implement uploads by **streaming the request body directly to R2** with a
    single `MEDIA.put(r2_key, request.body, { httpMetadata })` call — do not
    buffer the whole file in memory or store it as a D1 value. Take the media
    type from the `Content-Type` header and the title from a validated field,
    reject unsupported content types and oversized uploads (enforce a
    `Content-Length` guard and a streamed byte cap, similar to the
    `body-limit.ts` middleware but sized for media), and create the D1 row as a
    `draft` only after the object is stored. New uploads are always unpublished.
12. Implement downloads with `MEDIA.get(r2_key, { range, onlyIf })`, writing the
    object's HTTP metadata, `etag`, `Content-Type`, `Content-Disposition`, and
    `Accept-Ranges` onto the response and honoring range/conditional headers so
    audio and video stream and seek correctly. The public
    `GET /api/library/:id/content` route serves **only** published objects
    (`404` otherwise); the authenticated `GET /api/studio/media/:id/content`
    route serves the caller's own objects including drafts. Never expose the R2
    bucket directly; all reads go through the authorized Worker.
13. Implement publish and delete: publish flips `status` to `published` and sets
    `published_at`; delete removes the R2 object first, then the D1 row, so a
    successful delete leaves no object and no metadata. Every studio query and
    R2 key is scoped to the verified owner; return RFC 9457 problem details for
    all errors (`404` for missing/unauthorized items so ownership is not
    leaked). Organize the routes as `src/worker/routes/library.ts` and
    `src/worker/routes/studio.ts`, mounted from `src/worker/index.ts` (routing
    only). `cloudflareAccess()` runs once globally over the whole app (step 6);
    the shared `accessPolicies` array is what distinguishes the authenticated
    `/api/studio/*` routes from the public `/api/library/*` routes, so the studio
    router itself only adds its owner-scoping logic, not a second Access mount.
14. Emit informational structured logs via `cloudflareLogger()` — `media_uploaded`,
    `media_published`, `media_downloaded`, `media_deleted` — each placed **after**
    the Access and validation/ownership guards so they reflect only successful,
    authorized activity. Log the media id and non-sensitive metadata; never log
    tokens, authorization headers, object bytes, or unnecessary personal data.

### Phase 4 — Browser application

15. Build a focused, responsive Vue 3 + Vuetify interface meeting WCAG 2.2 AA on
    desktop and mobile, using Feather Icons, Pinia for state, and Vue Router:
    - `/` — public library: a grid/list of published items with an inline image
      preview or audio/video player and a download control. Unauthenticated
      users see a clear "Sign in to upload" affordance.
    - `/media/:id` — public detail page: full metadata plus stream/download.
    - `/studio` — authenticated management: an upload form (title + file with a
      client-side type/size check and upload progress), the caller's own drafts
      and published items, and publish/delete actions with the draft/published
      status visible. Show the signed-in identity and an unconditional logout
      control.
16. Use two Pinia stores — a public `library` store and an owner-scoped `studio`
    store — and keep `src/client/main.ts` bootstrap-only with `App.vue`, `views/`
    (one file per routed page), and `stores/`. Configure static assets to run the
    Worker first only for `/api/*`; all page routes (including `/studio`, which
    Access gates at the edge) fall through to the SPA `ASSETS` fallback.

### Phase 5 — Tests, deployment, and documentation

17. Add the three Vitest projects listed from a root `vitest.config.ts`:
    - `src/worker/vitest.config.ts` (`environment: node`, `name: worker`): unit
      tests for validation, the metadata repository, the R2 key/storage helper,
      and the published-vs-draft access decision logic.
    - `src/client/vitest.config.ts` (`environment: jsdom`, `name: client`,
      `@vitejs/plugin-vue`): component/behavior tests with `@vue/test-utils` and
      `@pinia/testing` for the upload form, library grid, and studio actions.
    - `tests/integration/vitest.config.ts` (`name: integration`,
      `@cloudflare/vitest-pool-workers`, `configPath` resolved from
      `import.meta.dirname`): the Worker in real `workerd` against real D1 and R2
      (or their Workers test equivalents), using
      `@adrianhall/cloudflare-toolkit/testing` helpers for Access identities.
18. Integration tests MUST cover the complete primary workflow and the access
    boundaries, not just the happy path:
    - Upload creates a private draft; an anonymous request cannot list it, read
      its metadata, or download its content.
    - Publish makes it visible and downloadable through `/api/library/*`.
    - The owner can stream their own draft via `/api/studio/media/:id/content`.
    - A different authenticated user cannot read, publish, delete, or download
      another user's item (per-owner isolation), and unauthenticated and
      wrong-identity requests are rejected on every `/api/studio/*` route.
    - Delete removes **both** the R2 object and the D1 row (assert the object is
      gone from the bucket and the row is gone from D1).
    Configure `@vitest/coverage-istanbul` and a `test:coverage` script; treat
    uncovered authored source as a gap to close.
19. Provide single-command `npm run deploy` (Terraform init/apply, generate
    `wrangler.jsonc` + types with `generate-wrangler -cf --terraform infra`, D1
    remote migrate, `vite build`, `wrangler deploy`) and `npm run teardown`,
    composed from small `package.json` scripts chained with `run-s`. Because R2
    rejects destroying a non-empty bucket, `teardown` MUST run a `preteardown`
    step that invokes `@adrianhall/cloudflare-toolkit`'s `empty-r2-bucket` CLI
    (`empty-r2-bucket -t infra --env-file .env --yes`) before `terraform
    destroy`. The CLI uses the demo's ordinary `CLOUDFLARE_API_TOKEN` to call
    the dashboard-observed
    `DELETE /client/v4/accounts/{account_id}/r2/buckets/{bucket_name}/objects?prefix=`
    API and reads the account ID and bucket name straight from
    `terraform output -json`; do not provision an S3 token or a hand-written
    R2-emptying script for this demo. The endpoint is undocumented, so keep the
    rationale and copy guidance in `docs/DECISIONS.md` and `AGENTS.md` current. Add a
    `postteardown` step
    that removes the generated `wrangler.jsonc` and `worker-configuration.d.ts`.
    A successful teardown leaves no named or billable resources — no Worker, D1
    database, R2 bucket, or Access applications.
20. Write `README.md` (operator/developer guide: prerequisites, architecture,
    the D1-metadata/R2-content split, the optional-authentication Access model,
    env config, local dev, testing, observability, exact deployment and
    verification steps, troubleshooting, and exact teardown including the R2
    empty step) and `DEMO.md` (presenter guide covering the public-library vs
    authenticated-studio model, the upload → publish → public download → delete
    flow, where to find the `media_*` logs in Workers Logs, and how to confirm
    object + metadata removal in the R2 and D1 consoles), plus JSDoc on every
    authored TypeScript declaration describing implemented behavior.
21. Extend `.env.example` from the baseline with only what this demo needs:
    baseline permissions plus `Account: D1 - Edit`, `Account: Workers R2
    Storage - Edit`, `DEMO_DOMAIN`, `DEMO_NAME=media`, and
    `CLOUDFLARE_TEAM_DOMAIN` for Access. No `ADMIN_EMAIL` is required because any
    authenticated user is a valid creator. Never commit real secrets or the
    generated local configuration.
22. Verify formatting, linting, type checking, all three Vitest projects, the
    production build, the generated Wrangler configuration, and `terraform fmt
    -check` / `terraform validate` in `infra`. Do not run `terraform apply`,
    deploy, or destroy real resources unless the operator explicitly requests it
    and provides the environment.

### Note — `accessPolicies` ordering is fail-open for new routes

`cloudflareAccess()` evaluates `accessPolicies` in order, first match wins (as
in `demos/url-shortener` and `demos/todo-app`). Because this demo ends the array
with a catch-all `/` → `authenticate: false` entry to serve the public library
and pages, **any path that does not match an earlier `/studio*` or `/api/studio*`
entry falls through to that catch-all and is served publicly with no verified
identity.** That is correct for the only routes this demo defines, but it means
the array is fail-open: a future authenticated route MUST be added as an
explicit `authenticate: true` entry *before* the catch-all, or it will silently
become public. Add an integration test asserting any new `/api/studio/*` route
rejects unauthenticated requests so this cannot regress unnoticed.
