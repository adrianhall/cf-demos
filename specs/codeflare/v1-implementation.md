# Codeflare v1 — Implementation Plan

This plan implements [`v1-specification.md`](./v1-specification.md) as a sequence of shippable,
passing phases. It follows the baseline in [`00-introduction.md`](./00-introduction.md) and leaves
the file browser, sandbox, previews, and agentic coding explicitly for later versions.

## 1. Delivery rules

1. Build v1 in **`cf-terraform-demos/codeflare`** using Vue 3 Composition API, TypeScript, Vite,
   Hono, the Cloudflare Vite plugin, Cloudflare Access, Artifacts, D1, Terraform, and `cf`.
2. Use pnpm only. Do not add Wrangler, a `wrangler.jsonc`, npm/yarn lockfiles, or a per-demo `.env`.
3. Keep the four-tier dependency direction: UI → API routes → application/domain → infrastructure.
   The Worker entry point is the sole composition root. Routes do not construct adapters.
4. Use `@demos/worker-common` for Access middleware, identity extraction, `/api/me`, JSON body
   handling, and standard problem responses. Do not create local copies.
5. Every authenticated operation derives the actor only from `currentIdentityEmail()`. Neither the
   browser nor a request body/header/query parameter can choose an owner.
6. An Artifacts repo token is sensitive plaintext. It is returned only from the immediate token-mint
   response, held transiently by the dialog, and never logged, persisted, cached, put in a URL, or
   placed in a test snapshot.
7. Every phase adds tests at the lowest suitable tier and ends with `pnpm check` and `pnpm test`.
   Offline tests use an Artifacts port fake, not the remote Artifacts service.
8. Before changing Artifacts configuration or lifecycle behaviour, re-check current Artifacts docs
   and the installed `cf` config types. The service is in open beta and its control-plane/type
   surface can change.
9. Never silently fall back from an Artifacts failure to a fake success. A Worker-side error must
   produce a safe RFC 9457 response, leave a diagnosable structured log, and preserve the D1 record
   unless the documented compensation action succeeds.
10. Run the manual live validation in Phase 7 after deployment. It is not part of `pnpm test` or
    `pnpm check`.

## 2. Cross-phase acceptance command set

At the end of each phase, run:

```sh
pnpm check
pnpm test
```

`pnpm check` is write-free and covers generated-type freshness, strict TypeScript, Oxfmt check,
type-aware Oxlint, Terraform validation and format check, plus phase-specific contract tests.
`pnpm test` runs domain, Worker, Vue DOM, and offline Workers-runtime suites as applicable. Every
integration project declares finite `testTimeout` and `hookTimeout` values.

## 3. Phase 1 — Scaffold, lifecycle, and Artifacts spike

### Goal

Create the deployable Codeflare scaffold and verify the fast-moving Artifacts integration points
before product code depends on them.

### Deliverables

1. Create `cf-terraform-demos/codeflare` as a pnpm workspace package. Add strict TypeScript, Vue 3,
   Vite, `@cloudflare/vite-plugin`, `@vitejs/plugin-vue`, Hono, `@demos/worker-common`,
   `@adrianhall/cloudflare-toolkit`, `@cloudflare/vitest-plugin`, testing libraries, Oxfmt,
   type-aware Oxlint, Vitest/Istanbul, Terraform, and `npm-run-all2`, matching current repository
   pins and policy.
2. Add the standard file structure:

   ```text
   cf-terraform-demos/codeflare/
   ├── src/client/{components,composables,router,services,views}/
   ├── src/worker/{routes,middleware,application,domain,infrastructure}/
   ├── tests/{client,worker,integration}/
   ├── migrations/
   ├── infra/
   ├── scripts/
   ├── cloudflare.config.ts
   ├── access-policies.ts
   ├── vite.config.ts
   ├── vitest.config.ts
   └── README.md
   ```

3. Add `cloudflare.config.ts` using `defineConfig()` and `defineWorker()`. Configure a current
   compatibility date, `nodejs_compat` only if generated Artifacts types or project dependencies
   require it, Workers Dev/preview behaviour, static assets, and observability.
4. Add a minimal Hono Worker composition root with public `GET /api/health` and toolkit RFC 9457
   error/not-found handling. Add a Vue landing-page placeholder and SPA asset fallback.
5. Add `infra/providers.tf`, `codeflare.tf`, `access.tf`, `outputs.tf`, `outputs.ts`, and committed
   `local-outputs.json`. Terraform owns Worker registration/bootstrap deployment, custom hostname,
   D1, and Access. Use root `.env` through the dotenv provider.
6. Define `worker_name` and `hostname` Terraform variables. Derive database names, access names,
   custom hostname, script deletion target, and production Artifacts namespace names from them.
   Do not hard-code those names downstream.
7. Add `scripts/artifacts-namespace.ts`, built on the `cf artifacts namespaces` API/CLI surface or
   its authenticated Cloudflare API equivalent. It must support idempotent `ensure` and `delete`
   operations, use `CLOUDFLARE_ACCOUNT_ID` and credentials from root environment without printing
   them, and return useful safe failures. It owns Artifacts namespace lifecycle because current
   Cloudflare Terraform provider v5 has no Artifacts namespace resource.
8. Define two clearly named, demo-owned namespaces: one for local development and one for deployed
   production. The local namespace name must be deterministic and real, not a fictitious UUID
   placeholder: `pnpm start` needs a remote Artifacts namespace because the current Miniflare plugin
   proxies Artifacts remotely. Avoid allowing `cf dev` to reach the production namespace.
9. Bind `ARTIFACTS` through `bindings.artifacts({ namespace })`. In local configuration set
   `dev: { remote: true }`; production binds the Terraform-output production namespace. Confirm
   `cf workers types --mode development` generates the `Artifacts` binding type.
10. Add script wiring:
    - `start`: ensure development namespace → local D1 migration → `cf dev --persist-to .cloudflare/state`;
    - `deploy`: ensure namespaces → Terraform init/apply → write `infra/outputs.json` → remote
      migration → Vite production build → `cf deploy --prebuilt`;
    - `teardown`: delete deployed Worker → delete the production and development demo namespaces →
      Terraform destroy;
    - `check` and `fix` according to the repository contract.
11. Add `specs/codeflare/artifacts-spike.md` recording the installed `cf`, Vite plugin, Miniflare, and
    Workers-types versions; verified `bindings.artifacts()` syntax; local remote-proxy requirement;
    namespace create/delete command shape; generated type availability; and any deviation required
    by actual `cf` behaviour. The spike uses a throwaway namespace/repository and removes it before
    completion.
12. Update root `.env.example` with **Entire Account → Developer Platform → Artifacts: Edit**.

### Tests

- Type generation sees `Env.ARTIFACTS` as `Artifacts`; no hand-written binding declaration exists.
- Configuration tests verify development uses `dev.remote: true`, production uses the output-derived
  namespace, and the two namespaces cannot resolve to the same value.
- Lifecycle script contract tests verify: Worker deletion precedes namespace deletion; namespace
  deletion precedes Terraform destroy; `check` cannot invoke remote namespace mutation; and no
  script invokes Wrangler.
- Terraform validates/formats and outputs every required scalar.
- A built app shell and public `/api/health` run locally.
- The throwaway live spike confirms Artifacts namespace creation, binding access, repo creation,
  repo deletion, and namespace deletion. Its credentials/tokens never enter logs or committed files.

### Exit criteria

A clean checkout can generate types, start the landing page, and run all offline checks/tests.
`specs/codeflare/artifacts-spike.md` records a real, current remote-binding validation and no temporary Artifacts
resource survives it.

## 4. Phase 2 — Access, identity, and application shell

### Goal

Provide the production-equivalent authentication boundary and GitHub-like application shell before
repository features exist.

### Deliverables

1. Implement one shared `buildPolicies()` definition used by Access middleware and the Vite local
   Access plugin. Make `/` and `/api/health` public; protect `/app*`, `/api/me`, and
   `/api/repositories*`; use `redirect: false` on API policies.
2. Add Terraform Access bypass/authenticated policies and path-specific applications. Export the
   authenticated application's audience as `access_aud`; bind it as `ACCESS_AUD`.
3. Compose `createAccessMiddleware`, `currentIdentityEmail`, `createMeRouter`, same-origin JSON
   mutation enforcement, structured logging, and RFC 9457 error handling. Ensure public routes are
   explicitly excluded rather than falling through accidentally.
4. Implement `GET /api/me` and the typed client identity API.
5. Implement Vue shell components with brand, public/authenticated navigation, verified identity,
   **Your repositories**, sign out, loading state, and failure-safe identity state. Use ordinary
   navigation from the public page to `/app`.
6. Implement `/app` and `/app/repositories` placeholders with semantic headings, empty-state action
   placeholders, responsive layout, keyboard behaviour, and visible focus.
7. Document Access prerequisites and local development identity in `README.md`.

### Tests

- Public document/health paths are reachable anonymously; all `/app*`, `/api/me`, and repository
  API prefixes reject an absent token.
- Workers-runtime tests reject a valid JWT for another Access application in the same team, an
  expired token, and a non-matching audience.
- The shell renders anonymous, loading, authenticated, and inaccessible identity states.
- Protected mutation middleware rejects missing/foreign origin and incorrect JSON content type.
- Local policy builder and Terraform destination list are tested against one shared expected route
  inventory to prevent posture drift.

### Exit criteria

A public visitor sees the landing page; an authenticated visitor sees a working application shell.
No protected route trusts edge Access alone or a browser-provided identity.

## 5. Phase 3 — Domain model, D1 registry, and Artifacts adapter

### Goal

Create the ownership model and server-side seams that make personal repositories safe before
exposing them to the browser.

### Deliverables

1. Add initial D1 migration creating `repositories` exactly as specified: opaque id, owner email,
   display name/key, description, opaque Artifacts name, default branch, timestamps, and uniqueness
   constraints. Include explanatory schema comments for the intentional absence of roles, raw Git
   tokens, and Git object data.
2. Add `RepositoryName`, `RepositoryDescription`, `RepositoryId`, `ArtifactsRepositoryName`, and
   token request domain values/functions. Document normalization, validation errors, generated-name
   rules, and allowed TTL/scope values with complete JSDoc.
3. Define `RepositoryRegistryPort`, `ArtifactsRepositoryPort`, `Clock`, and `IdGenerator` in the
   application/domain boundary. Do not expose `Artifacts` types above the infrastructure adapter.
4. Implement the D1 registry adapter, including owner-scoped list/get/update/delete queries and
   mapping SQLite uniqueness failures to domain conflict errors.
5. Implement the Artifacts binding adapter. It creates an empty `main` repository, reads current
   metadata, mints scope/TTL-constrained tokens, deletes a repo, and releases every `get()`
   capability via `using`.
6. Implement application services for create, list, get, update metadata, delete, and mint Git
   token. Create uses Artifacts first then D1; it attempts compensating Artifacts deletion if D1
   persistence fails. Delete resolves the owner-scoped D1 record before deleting Artifacts then D1.
7. Define safe application DTOs. The ordinary repository projection does not include Git remotes or
   any token. The token-mint DTO is the only DTO containing plaintext and exists only in memory.
8. Add a fake Artifacts port and deterministic clock/id generator for offline tests. It must model
   the externally visible error/status cases but never synthesize a realistic plaintext token that
   could be mistaken for a credential.

### Tests

- Validation covers every acceptance/rejection/canonicalisation case, including case-insensitive
  duplicate display names and generated name compliance with Artifacts rules.
- Registry tests prove owner-scoped queries do not return another user's data.
- Application tests prove an Artifacts create failure writes no D1 row; a D1 failure triggers one
  compensation attempt; compensation failure produces an operational error with no accidental
  success response.
- Delete tests prove Artifacts deletion occurs before D1 removal and a D1 record remains after an
  Artifacts failure.
- Token tests prove TTL/scope reach the port exactly, plaintext is not returned by normal queries,
  and no service retains it after the mint response is constructed.
- Adapter tests assert disposable repo handles are released on info/token/delete operations.

### Exit criteria

The full repository lifecycle exists behind typed, offline-tested services. D1 is the only source
of application ownership and Artifacts is the only source of Git data/token authority.

## 6. Phase 4 — Repository API and authorization boundary

### Goal

Expose the repository services through the specified secure HTTP API.

### Deliverables

1. Add thin Hono routes for every `/api/repositories` endpoint. Routes extract identity, apply
   `jsonBodyLimit()` then `readJsonBody()`, invoke a service, and shape safe JSON/problem responses.
2. Add bounded cursor pagination to the list service/route. Use stable ordering by most recently
   updated timestamp then id; validate malformed cursors and limits as `400` problems.
3. Implement create, details, metadata patch, delete, and token-mint schemas. The patch endpoint
   must update only display name/description; no request shape contains owner, Artifacts name,
   remote, default branch, or arbitrary token lifetime.
4. Map malformed input to validation problems, duplicates to conflict, inaccessible ids to uniform
   not-found, Artifacts unavailable states to a safe dependency/operational problem, and unexpected
   failures to a generic internal problem without a stack trace.
5. Add structured action logs carrying request id, Codeflare repository id when known, action,
   outcome, Artifacts status/error category, and duration. Explicitly redact Authorization values
   and tokens.
6. Add a static architecture test that production routes do not import D1/Artifacts adapters or
   `env.ARTIFACTS`, and that only the Artifacts adapter references the binding.

### Tests

- Every mutation rejects absent/foreign origin, wrong media type, body above 8 KiB, malformed JSON,
  and extra/unsupported fields according to the chosen schema policy.
- Two authenticated identities prove list isolation plus uniform `404` for get, patch, delete, and
  token mint on a foreign id.
- Response tests prove normal list/detail responses exclude remote and tokens; mint response has the
  correct scope/expiry/remote contract.
- Logging tests prove a successful and failed token mint record action/context but never the token,
  Authorization header, email, or repository description.
- Workers-runtime tests exercise Access plus at least create/list/foreign-id mutation against a fake
  application port with a finite timeout.

### Exit criteria

The browser has a complete authorization-safe API. A route handler contains no repository business
rules or binding calls, and a non-owner cannot distinguish a private repository from an unknown id.

## 7. Phase 5 — GitHub-like repository experience

### Goal

Deliver the signed-in home, personal repository list, and repository overview pages as an accessible
complete user experience.

### Deliverables

1. Build typed client API methods and a repository-list composable handling cancellation, loading,
   retries, empty data, safe problem rendering, and stale response disposal.
2. Implement `/app` dashboard: welcome/identity, repository count, recent repositories, prominent
   new-repository action, and a useful no-repository onboarding state.
3. Implement `/app/repositories`: repository list/cards, safe timestamp formatting, empty/loading/
   error states, pagination or load-more behaviour consistent with cursor API, and navigation using
   Codeflare IDs.
4. Implement repository create as an accessible modal or route form. Use labels, character count,
   inline validation, busy state, Escape/cancel, focus trap/restoration if modal, and duplicate-name
   problem display. On success, navigate to the created repository overview.
5. Implement `/app/repositories/:id` overview with display metadata, default branch, current
   Artifacts state, last update/create dates, copyable non-sensitive remote, edit metadata, and
   delete confirmation. Copying a remote is allowed because it is not a credential; it must not
   include a token.
6. Treat `ready` as operational, and `importing`/`forking`/unknown as **Preparing**. Disable Git
   credential creation while non-ready and expose a text explanation.
7. Implement responsive, GitHub-inspired layout with Codeflare branding and no GitHub trademarked
   assets/copy. Use scoped, maintainable CSS or the project’s chosen styling pattern; do not add a
   UI framework solely for this small surface.

### Tests

- Vue DOM tests cover dashboard list/empty/error states, list pagination, creation happy/error
  paths, details rendering, edit metadata, delete confirmation, and retry states.
- Keyboard tests cover navigation, form labels/error descriptions, dialog focus/escape/restore,
  visible focus, and error/success status announcements.
- Client tests ensure only Codeflare IDs are used in links/API operations and route change cancels
  stale requests.
- Browser review at desktop and narrow widths confirms no clipped actions, no hover-only controls,
  adequate contrast, and an understandable empty-state path.

### Exit criteria

An authenticated user can create and manage a personal repository entirely through a coherent,
accessible web UI, excluding only Git credentials and external Git commands.

## 8. Phase 6 — Git-token UX and standard Git workflow

### Goal

Complete the v1 Artifacts demonstration: an owner can safely mint an expiring Git credential and
use it with standard Git over HTTPS.

### Deliverables

1. Add a Git-token dialog on the repository overview. Offer read/write scope and exactly the three
   documented lifetimes (15 minutes, 1 hour, 8 hours), with plain-language permissions/exposure
   warnings.
2. Request the mint endpoint only after explicit user confirmation. Render the returned sensitive
   token in a dedicated disclosure, render expiry as an absolute timestamp plus relative duration,
   and provide copy controls for token and commands.
3. Generate commands using Git's recommended `http.extraHeader` approach, never a URL with a
   credential embedded in it:

   ```sh
   git -c http.extraHeader="Authorization: Bearer <token>" clone "<remote>"
   ```

   Include an equivalent push command for write scope and explain that the user may replace the
   placeholder only in their terminal, not in a checked-in file.
4. Clear the token and command strings from reactive state when the dialog closes, component
   unmounts, minting fails, or repository route changes. Do not persist the dialog component state.
5. Add friendly handling for token mint errors, repository-not-ready, expired display time, and
   clipboard denial. Do not expose a revoke-token UI in v1; Artifacts repo deletion is the only
   lifecycle action v1 needs.
6. Write `GIT-VALIDATION.md` as a re-runnable manual runbook. It must use a throwaway personal
   repository, temporary local clone directory, Git's `http.extraHeader`, a read token for clone,
   a write token for push, scope refusal, expiry verification, deletion, and cleanup. It must not
   instruct users to paste a token into a remote URL.

### Tests

- Client tests assert scope/TTL selection, disabled busy state, one explicit mint action, copied
  command content, clipboard error status, and clearing token text after close/unmount/navigation.
- API/application tests prove an ordinary repository response never contains token plaintext and
  only immediate mint responses can contain it.
- Static/log tests search client/server production sources and fixtures for prohibited persistence:
  `localStorage`/`sessionStorage` token writes, token query params, and token log fields.
- Accessibility tests verify scope/lifetime labels, sensitive disclosure warning, expiry text, copy
  result announcement, and keyboard dialog behaviour.

### Exit criteria

The UI gives an owner enough safe, accessible information to clone and push with a normal Git
client. Token text never outlives the immediate dialog interaction in Codeflare.

## 9. Phase 7 — Documentation, hardening, and release review

### Goal

Turn the completed vertical slice into production-quality reference material and prevent regression
of its boundaries.

### Deliverables

1. Finish `README.md` with prerequisites, root `.env` token permission, how local Artifacts remote
   proxy mode differs from emulated D1/Access, every command, Access route postures, Artifacts/D1
   roles, namespace naming/cleanup, Git-token safety, and Artifacts limits.
2. Add `DEMO.md` with a concise presenter flow: landing page → Access sign-in → create repo → mint
   token → clone/push in terminal → refresh repository metadata → delete/teardown.
3. Add `EXPLAIN-DEMO.md` explaining control plane vs data plane, why D1 records ownership but not
   Git files, why Access and Artifacts use separate credentials, why raw tokens are one-time, and
   why v1 deliberately stops before file browsing/sandboxes.
4. Reconcile `.env.example`, Terraform comments/outputs, `local-outputs.json`, deployment scripts,
   and diagrams/documentation with actual resource ownership.
5. Add architecture guard tests: no client imports a Worker module; no domain/application module
   imports Hono, Vue, D1, or Artifacts; no route creates adapters; no binding is read outside the
   composition root/infrastructure adapter.
6. Run accessibility review against WCAG 2.2 AA, including keyboard paths, focus order, form
   errors, target size, responsive reflow, status updates, contrast, and token disclosure.
7. Run a focused security review for Access audience checking, owner isolation, CSRF/origin checks,
   sensitive data retention, Terraform/output exposure, and destructive teardown ordering.
8. Record the currently verified Artifacts platform limits in the README (at specification time:
   1 GB per repository, 32 MB per blob, 1 TB/account, and 2,000 Git/control-plane requests per 10
   seconds) with a link to the live limits documentation instead of presenting them as permanent.

### Tests and exit criteria

- `pnpm check`, `pnpm test`, and the configured coverage gate pass.
- A clean checkout can run `pnpm start` after root `.env` setup.
- A deployment smoke check follows `GIT-VALIDATION.md`, including clone/fetch/pull with a read
  token, push denial with that token, push success with a write token, token expiry, and repository
  deletion.
- `pnpm deploy` followed by `pnpm teardown` leaves the account clean, including both demo-owned
  Artifacts namespaces. The teardown proof lists resources by derived demo names and never uses a
  broad account-wide delete.
- The final review confirms v1 does not accidentally include v2 file-browser/sandbox behaviour or
  future organization/role semantics.

## 10. Phase 8 — Optional parity polish after v1 sign-off

This phase is optional and must not block v1. It exists only for small, non-scope-expanding
improvements discovered in presentation or usability review, such as timestamp wording, copy text,
empty-state illustration, repository-card density, or a better safe Git-command explanation.

Every change must preserve the v1 API, Access, D1, Artifacts, credential-retention, and lifecycle
contracts. A request that adds file content inspection, import/fork, persistent tokens, collaborator
access, sandbox sessions, or an AI feature is future-version work and requires a new specification
before implementation.
