# Demo 2: Personalized TODO App

Directory: `demos/todo-app`

Domain: `tasks.cfapps.uk`

Cloudflare products: Workers, Cloudflare Access, and D1.

## Behavior

- Provide a UI for managing a TODO list, a la [todomvc](https://todomvc.com/)
- Use the authenticated user to ensure users don't see each others tasks

## Demo Flow

1. Create a todo, check it off, delete it.
2. Open Workers Logs and locate the informational usage log.
3. Use the D1 console to do SQL queries

## Relevant Skills

**Cloudflare / Backend specific skills:**

- `cloudflare`
- `cloudflare-one`
- `cloudflare-terraform-best-practices`
- `cloudflare-toolkit`
- `workers-best-practices`
- `wrangler`

**Vue / UI specific skills:**

- `vue-best-practices`
- `vue-options-api-best-practices`
- `vue-pinia-best-practices`
- `vue-router-best-practices`
- `vue-testing-best-practices`

## Implementation Plan

### Phase 1 — Scaffold and shared infrastructure

1. Create an independent `demos/todo-app` demo using Vue 3, Vuetify, Pinia, Vue
   Router, Vite, Hono, and TypeScript, following the canonical
   `demos/url-shortener` layout (`infra/`, `src/worker/`, `src/client/`,
   `tests/integration/`, `.env.example`, `README.md`, `DEMO.md`).
2. Provision the baseline resources with Terraform: a Worker, the
   `tasks.cfapps.uk` custom domain (with the one-time inert bootstrap
   deployment so `cloudflare_workers_custom_domain` can attach), Workers Logs,
   and automatic tracing with explicit sampling. Read all configuration from
   `../.env` via the `dotenv` provider; set `DEMO_NAME=tasks` and
   `DEMO_DOMAIN=cfapps.uk`.
3. Provision a D1 database with Terraform and export its binding details as
   Terraform outputs. Terraform owns the database resource; Wrangler owns
   schema migrations.
4. Commit a single `wrangler.jsonc.tpl` with `{{placeholder}}` markers for every
   Terraform-sourced value (Worker name, D1 database id/name, Access audience),
   plus a committed `infra/local-outputs.json` that
   `generate-wrangler -c -l infra/local-outputs.json` fills with hardcoded
   local values, wired into `prebuild`, `prestart`, and `precheck:types`.
   Generate binding types from `wrangler.jsonc`; never hand-maintain the
   binding interface.

### Phase 2 — Cloudflare Access (per-user identity)

5. Because the scenario's whole purpose is isolating each user's tasks, gate the
   entire `tasks.cfapps.uk` hostname with a single Cloudflare Access self-hosted
   application backed by an allow policy that requires authentication through a
   configured identity provider — no public bypass policy. The SPA shell is
   served by the `ASSETS` `single-page-application` fallback and is gated at the
   edge by Access before the request reaches the Worker.
6. Protect the `/api/*` routes in the Worker with `cloudflareAccess()`.  Since this
   is a demo, do **NOT** validate the Audience with `cloudflareAccess()`.  Derive
   the current user's stable identity (email) from the verified Access identity on
   every request — never from client-supplied input.
7. Configure the toolkit's development-only `cloudflareAccessPlugin()` in
   `vite.config.ts` before `cloudflare()`, sharing one path-policy array
   (`src/access-policies.ts`) with the Worker middleware. Provide selectable dev
   `users` matching `.env.example` defaults, and enable development tokens only
   behind `import.meta.env.DEV`. Render an unconditional logout control that
   navigates to `/cdn-cgi/access/logout`.

### Phase 3 — Data model and API

8. Define the D1 schema as a Wrangler migration: a `todos` table keyed by an
   immutable UUID with `user_id` (the verified identity), `title`, `completed`,
   and `created_at`/`updated_at` columns, indexed on `user_id`. Run migrations
   through Wrangler in `npm run deploy`.
9. Implement the todo domain as separate files under `src/worker/todos/` (a D1
   repository, input validation, and types), imported by a `routes/` sub-router
   and mounted from `src/worker/index.ts` (routing only).
10. Implement an authenticated CRUD API at `/api/todos`
    (`GET` list, `POST` create, `PATCH /:id` toggle/rename, `DELETE /:id`). Every
    query MUST be scoped to the authenticated `user_id` so users can never read
    or mutate another user's tasks. Validate all input and return RFC 9457
    problem details for errors.
11. Emit an informational structured log (for example `todo_created`) via
    `cloudflareLogger()` when a todo is created, placed after the Access and
    validation guards so it reflects only successful, authorized activity.
    Never log the task contents beyond what the demo needs, and never log tokens
    or authorization headers.

### Phase 4 — Browser application

12. Build a focused, responsive TodoMVC-style Vue 3 + Vuetify interface: add a
    task, check it off, and delete it, meeting WCAG 2.2 AA on desktop and mobile.
    Use Pinia for todo state and Vue Router for navigation, showing the signed-in
    identity and the logout control.
13. Configure static assets to run the Worker first only for `/api/*`; all page
    routes fall through to the SPA `ASSETS` fallback (Access gates them at the
    edge).

### Phase 5 — Tests, deployment, and documentation

14. Add the three Vitest projects: `worker` (unit tests for validation,
    repository logic, and middleware), `client` (jsdom component/behavior tests
    with `@vue/test-utils` and `@pinia/testing`), and `integration`
    (`@cloudflare/vitest-pool-workers` against real D1). Integration tests MUST
    cover per-user isolation and Access enforcement for unauthenticated and
    wrong-identity requests on every `/api/*` route, plus the complete
    create → complete → delete workflow. Configure `@vitest/coverage-istanbul`
    and a `test:coverage` script.
15. Provide single-command `npm run deploy` (infra apply, generate wrangler +
    types, D1 migrate, build, deploy) and `npm run teardown` (destroy), composed
    from small `package.json` scripts. A successful teardown leaves no named or
    billable resources, including the D1 database.
16. Write `README.md` (operator/developer guide: prerequisites, architecture,
    env config, local dev, testing, observability, deployment, verification,
    troubleshooting, teardown) and `DEMO.md` (presenter guide covering the
    Access-authenticated per-user model, the create/complete/delete flow, where
    to find the usage log in Workers Logs, and how to run the D1 console query),
    plus JSDoc on every authored TypeScript declaration.
17. Verify formatting, linting, type checking, all Vitest projects, the
    production build, generated Wrangler configuration, and `terraform fmt
    -check` / `terraform validate` in `infra`.
