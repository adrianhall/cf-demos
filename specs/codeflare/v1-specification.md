# Codeflare v1 — Engineering Specification

## 1. Purpose and scope

Codeflare v1 is an authenticated, web-based personal source-code workspace built around
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/). It demonstrates that a
Cloudflare Worker can provide the control plane for Git-compatible repositories while Cloudflare
Artifacts provides the Git data plane.

A signed-in user can create, view, rename, and delete only their own repositories. For every
repository, Codeflare can mint a short-lived, repo-scoped Git token and reveal a command that works
with ordinary HTTPS Git clients. The user may clone, fetch, pull, and push through the Artifacts
remote. The web UI is intentionally similar in information architecture to GitHub's signed-in home
and repositories pages, but does **not** yet provide file browsing, editing, issues, pull requests,
teams, or organizations.

The implementation lives at **`cf-terraform-demos/codeflare`**. It uses Vue 3, TypeScript, Vite,
Hono, Cloudflare Workers, Cloudflare Access, Cloudflare Artifacts, D1, and Terraform for the
resources Terraform can manage. The `cf` CLI owns Artifacts namespace lifecycle and Worker code
deployment; Terraform owns the Worker registration, custom hostname, D1 database, and Access
controls.

This specification is the authority for v1. The broader staged roadmap remains in
[`00-introduction.md`](./00-introduction.md), and the feature inventory in
[`01-github-features.md`](./01-github-features.md) records capabilities reserved for later versions.

### 1.1 Product goals

1. Demonstrate Artifacts as Git-compatible, versioned repository storage through its Workers
   binding and HTTPS Git protocol.
2. Provide a GitHub-like personal repository dashboard with clear empty, loading, error, and
   populated states.
3. Ensure a user can enumerate or mutate only their own Codeflare repositories, even though all
   repositories initially share one Artifacts namespace.
4. Use Cloudflare Access as the identity provider and validate the Access JWT and intended audience
   inside the Worker on every authenticated API request.
5. Give users a usable standard-Git onboarding flow without exposing a Cloudflare API token or
   storing a plaintext repo token.
6. Teach a production-quality four-tier Worker design and a complete, idempotent lifecycle:
   `pnpm start`, `pnpm check`, `pnpm test`, `pnpm deploy`, and `pnpm teardown`.
7. Keep v1 deliberately small enough to be a dependable foundation for the sandbox, preview, and
   agent capabilities planned in later versions.

### 1.2 Explicit non-goals

The following are intentionally deferred:

- Repository file browser, commit browser, diffs, README rendering, search, tags, releases, import,
  forks, or web-based Git writes.
- Sandboxes, terminal access, Monaco, browser previews, agents, AI Gateway, Workers AI, skills, or
  MCP servers.
- Organizations, teams, collaborators, public or internal repositories, and repository roles.
  Every v1 repository is private to exactly one Access identity.
- SSH Git protocol, deploy keys, persistent personal access tokens, Git LFS, or Git credential
  helpers.
- Pull requests, reviews, branch protection, issue tracking, discussions, wiki, packages, CI/CD,
  webhooks, or Worker publishing.
- A local emulation of the Artifacts data plane. The current Miniflare Artifacts plugin is a remote
  proxy rather than a local Git service, so v1 instead tests a port/adapter contract offline and
  documents the opt-in live validation required for the real binding and Git remote.
- Treating the Codeflare browser session as Git authentication. Cloudflare Access authenticates the
  web control plane; Artifacts repo-scoped tokens authenticate standard Git HTTPS operations.

## 2. Product model and user journeys

### 2.1 Personal-repository model

Codeflare maps each verified Access email address to a stable, opaque Artifacts repository name.
The application stores the ownership mapping in D1; it does not rely on a name prefix or on an
Artifacts list response to determine authorization.

All v1 repositories live in one deployment-specific Artifacts namespace. The namespace is a
technical boundary for the Worker binding, not an organization or a permission boundary. D1 is the
authoritative application record for ownership and presentation metadata; Artifacts is the
authoritative Git store.

| Concept | v1 representation | Authority |
| --- | --- | --- |
| User | Verified Access identity, identified by normalized email | Access JWT |
| Personal repository | One Artifacts repository plus one D1 `repositories` row | D1 for ownership/UI; Artifacts for Git data |
| Repository identifier | Opaque Codeflare UUID exposed by Codeflare APIs and UI | D1 |
| Artifacts repository name | Generated opaque name, unique in the configured namespace | Artifacts |
| Git remote | Artifacts-provided HTTPS remote | Artifacts |
| Git credential | Short-lived read or write Artifacts repo token | Artifacts; plaintext exists only in a mint response |

The Artifacts repository name must not be derived from an email address, display name, or arbitrary
user-supplied slug. This prevents identity disclosure in Git remotes and makes future rename and
organization migrations feasible. The human-readable Codeflare repository name is stored in D1 and
validated independently of Artifacts' name rules.

### 2.2 Routes and Access posture

The landing page is public; the application and every API route are authenticated. A real navigation
to `/app` crosses the Access boundary before the SPA runs.

| Path | Access posture | Purpose |
| --- | --- | --- |
| `/` | Public | Product landing page and sign-in call to action |
| `/app` | Authenticated | Signed-in home/dashboard |
| `/app/repositories` | Authenticated | Personal repositories list and creation entry point |
| `/app/repositories/:id` | Authenticated | Repository overview, metadata, and Git access instructions |
| `/api/me` | Authenticated | Verified identity for the application shell |
| `/api/repositories*` | Authenticated | Repository control-plane API |
| `/api/health` | Public | Minimal liveness endpoint; no repository information |

The UI uses normal document links when moving from the public landing page into `/app*`; it must not
turn an anonymous document into an authenticated view through client-side routing. Within the
authenticated application, Vue Router may manage navigation.

### 2.3 Core journeys

#### Sign in and view repositories

1. An anonymous visitor sees the public landing page and selects **Sign in**.
2. Cloudflare Access authenticates the visitor.
3. The authenticated shell calls `GET /api/me` and shows the verified display name/email.
4. The home page displays a welcome panel, repository count, recent repositories, and a link to
   **Your repositories**.
5. The repository list shows only D1 records owned by the verified actor, newest updated first.

#### Create a repository

1. The user selects **New repository** from the dashboard or repositories page.
2. A modal or dedicated accessible form collects a display name and optional description.
3. The domain validates the display name, canonicalizes allowed whitespace, and rejects empty,
   overlong, or duplicate names for that owner.
4. The application service generates an opaque Artifacts repo name and creates the repository with
   default branch `main` through the `ARTIFACTS` binding.
5. The service persists the corresponding D1 ownership record. If D1 persistence fails after
   Artifacts creation, it attempts compensating deletion and records a safe operational error; it
   never returns an unowned repository as a success.
6. The response includes safe repository metadata and redirects to the repository overview. The
   initial Artifacts token returned by `create()` is discarded; v1 does not reveal it or store it.

An empty Artifacts repository has no commit or files until the user pushes with Git. The UI explains
this rather than implying that a README or starter commit was created.

#### Clone or push with Git

1. On a repository overview page, the owner chooses a read-only or read/write Git token and a
   lifetime from a small documented set: 15 minutes, 1 hour, or 8 hours.
2. `POST /api/repositories/:id/git-tokens` verifies ownership, validates the scope and TTL, then
   calls `repo.createToken(scope, ttl)` through an Artifacts adapter.
3. The API returns the remote URL, plaintext token, expiry, scope, and a command using Git's
   `http.extraHeader`. The browser renders the token only in an explicit sensitive disclosure with
   copy control and expiry warning.
4. The UI tells the user that the token is shown once, is repo-scoped, and must not be put in a
   remote URL or committed to a repository. The displayed clone/push commands use the complete
   Artifacts remote and an `Authorization: Bearer` header.
5. The UI clears the sensitive token text when the dialog closes or route changes. Codeflare stores
   neither plaintext tokens nor browser-local copies.

Read tokens permit clone, fetch, and pull. Write tokens additionally permit push. A Git token is
not an Access JWT and cannot grant access to any other Artifacts repository.

#### Rename or delete a repository

- Rename changes only the Codeflare display name and description in D1. Artifacts repo names and
  Git remotes remain stable in v1.
- Delete requires a confirmation naming the repository. The application deletes the Artifacts repo
  first, then removes the D1 mapping. A not-found result is treated as a successful convergence case
  only after confirming the D1 record belongs to the actor. Failure leaves the D1 record intact and
  reports a recoverable error; the user can retry.
- Deleting a repository invalidates its Artifacts repository and associated repo tokens as part of
  Artifacts deletion. Codeflare does not retain a replacement remote or token.

## 3. Functional requirements

### 3.1 GitHub-like dashboard and repository UI

The visual direction is GitHub-like in hierarchy and familiarity, not a pixel-for-pixel copy or use
of GitHub branding.

| Surface | Required behaviour |
| --- | --- |
| Landing page | Explains private personal repositories, Artifacts-backed Git, and the v1 boundary; provides a clear sign-in action. |
| Application shell | Shows Codeflare brand, primary navigation, verified identity, repository navigation, and sign out. |
| Signed-in home | Shows welcome text, repository count, recently updated repositories, a prominent new-repository action, and an empty-state path when no repositories exist. |
| Repositories list | Supports loading, empty, error, and populated states; each card/row shows display name, description if present, default branch, created/updated timestamps, and Artifacts readiness state. |
| Create form | Uses visible labels, inline validation, description character count where appropriate, disabled busy state, live error announcement, cancel path, and focus restoration. |
| Repository overview | Shows display name, description, immutable Git remote, default branch, Artifacts status, creation/update data, clone/push instructions, token mint action, edit metadata action, and destructive delete action. |
| Git token dialog | Requires scope and lifetime choice, clearly identifies sensitive text, supports copying, displays expiry, never persists plaintext locally, and explains safe Git command usage. |
| Error presentation | Presents RFC 9457 problem `title` and safe `detail` accessibly. It does not expose binding exceptions, stack traces, repo tokens, or raw Git remotes beyond the authorized repository. |

Repository cards and rows must use the Codeflare opaque id in client navigation, not the Artifacts
name. An id for another user's repository must receive a uniform `404` response and no ownership
hint.

### 3.2 Repository states

Artifacts can report `ready`, `importing`, or `forking`. v1 only creates empty repositories, but it
must model and display an unknown/non-ready state safely so later import/fork capability does not
require a breaking API change.

- The UI calls a non-ready repository **Preparing** and disables Git-token minting until it is
  `ready`.
- The worker does not manufacture Git readiness from D1 timestamps.
- A repository with a missing Artifacts backing repo is an operational inconsistency. The API returns
  a safe problem response and logs the Codeflare id and Artifacts name without logs containing a
  token or user data. It is not silently recreated.

### 3.3 API surface

All API responses are JSON. All failures use RFC 9457 `application/problem+json`. State-changing
requests require an allowed same `Origin` and exact `application/json` content type before their
body is parsed.

| Route | Behaviour |
| --- | --- |
| `GET /api/health` | Public liveness response containing no identity, repository, or binding state. |
| `GET /api/me` | Returns the verified Access identity required by the shell, using `createMeRouter()`. |
| `GET /api/repositories?cursor=&limit=` | Lists the verified actor's repositories from D1 in a bounded, stable order. |
| `POST /api/repositories` | Creates an Artifacts repository and the owner mapping. Accepts `{ name, description? }`. |
| `GET /api/repositories/:id` | Returns safe repository metadata only if owned by the verified actor. |
| `PATCH /api/repositories/:id` | Updates display name and description only if owned by the verified actor. It never renames the Artifacts repository. |
| `DELETE /api/repositories/:id` | Deletes an owned Artifacts repository, then its D1 ownership record. |
| `POST /api/repositories/:id/git-tokens` | Mints one short-lived repo-scoped read/write Git token for the owner. Accepts `{ scope, ttlSeconds }`. Plaintext appears only in this response. |

The browser accesses the Worker only through a typed client API module. It never receives an
Artifacts binding, calls the Artifacts REST API, or holds a Cloudflare API token.

### 3.4 Validation and limits

The domain layer owns repository input validation. Initial limits are intentionally smaller than
Artifacts limits and may change only with tests and documentation updates.

| Field | Rule |
| --- | --- |
| Display name | 1–80 Unicode code points after trimming; letters, numbers, spaces, `.`, `_`, and `-`; no control characters; must not be `.` or `..`. |
| Description | Optional; maximum 280 Unicode code points after trimming; plain text only. |
| Duplicate display name | Case-insensitive unique per owner in D1. |
| List page size | Default 20; minimum 1; maximum 50. |
| Token scope | Exactly `read` or `write`. |
| Token TTL | Exactly 900, 3,600, or 28,800 seconds. These values all meet Artifacts' token minimum/maximum range. |
| Create body | Limited to 8 KiB via `jsonBodyLimit()` before parsing. |

An Artifacts namespace/repository name must satisfy platform rules: starts with a letter or digit;
remaining characters limited to letters, digits, `.`, `_`, or `-`; namespace length 2–63. The
application-generated Artifacts repo name must also stay within those rules. It is generated from a
fixed `repo-` prefix and a UUID-derived lowercase identifier, never accepted from the browser.

## 4. Security, authorization, and privacy

### 4.1 Cloudflare Access

Terraform provisions two path-specific Access applications on the Codeflare hostname:

- A public bypass application for `/` and `/api/health`.
- An authenticated application for `/app*`, `/api/me`, and `/api/repositories*`.

The Worker uses `@demos/worker-common`:

- `createAccessMiddleware({ buildPolicies, enableDevTokens: import.meta.env.DEV })`;
- `currentIdentity()` and `currentIdentityEmail()` to obtain the actor exclusively from a verified
  identity;
- `createMeRouter()` for `/api/me`;
- `jsonBodyLimit()` and `readJsonBody()` for JSON input.

The Worker validates token signature, expiry, and the exact `ACCESS_AUD` output for every protected
route. Access edge gating is not sufficient: an Access team shares a JWKS, so a token minted for an
unrelated application must fail Worker validation.

Local Access emulation uses the same policy builder and committed local audience placeholder.
Development tokens are statically unavailable in a production build.

### 4.2 Authorization invariant

Every repository application-service method accepts a verified actor email. It resolves the D1 row
by both `id` and `owner_email`; no route or Artifacts adapter accepts an actor supplied by a request
body, header, query parameter, or client state.

All inaccessible repository operations return the same non-enumerating `404` posture as an unknown
repository. This includes get, update, delete, and Git-token minting. Repository list results can
contain only records belonging to the verified actor.

### 4.3 Artifact and Git credentials

| Data | Permitted handling | Prohibited handling |
| --- | --- | --- |
| Cloudflare API token | Root `.env` only; deployment/control-plane tooling only | Browser, Worker variables, Git commands, logs, or source control |
| Artifacts binding | Worker environment only | Client bundle or application/domain tier |
| Artifacts initial create token | Discard immediately | D1, KV, logs, API response, browser storage |
| Minted Git plaintext token | One `POST` response and transient dialog state only | D1, KV, logs, analytics, route state, session/local storage, URL, or subsequent response |
| Token metadata | Not needed in v1; Artifacts remains authoritative | Treating metadata as a new Codeflare authorization model |
| Git remote | Returned only to the repository owner in overview/token response | Cross-user API responses or logs if it embeds user-controlled information |

Structured logs record an opaque request id, Codeflare repository id, action, Artifacts status, and
safe error category. They must never record an Access email, repository description, plaintext Git
token, `Authorization` header, or entire Artifacts exception object without sanitisation.

### 4.4 Browser protections

- Mutations reject missing/foreign origin and non-JSON input.
- The application has no cookie-authenticated public mutation endpoints.
- Token text is never rendered into a URL, initial page source, console log, error report, or
  clipboard automatically. Copy is an explicit user action.
- The token dialog warns that copied credentials may remain in the operating system clipboard; the
  browser cannot reliably erase it.
- Client escape hatches such as arbitrary remote URL input are deferred; v1 always uses the
  Artifacts remote returned for the owner-mapped repository.

## 5. Architecture

### 5.1 Four tiers

Dependencies point in one direction only:

```text
Vue UI → Hono API routes → application/domain → infrastructure
```

| Tier | Owns | Must not own |
| --- | --- | --- |
| UI | Rendering, local form state, navigation, accessible status, typed API client | Cloudflare bindings, direct Artifacts calls, ownership decisions |
| API routes | Hono registration, verified identity extraction, input limits/parsing, HTTP shaping | D1 construction, binding calls, business validation |
| Application | Repository use cases, owner checks, compensation policy, transaction boundaries | Hono objects, Vue imports, concrete Worker bindings |
| Domain | Value objects, validation, DTOs, ports, policy errors | `env`, fetch, D1, Artifacts, Access headers |
| Infrastructure | D1 and Artifacts adapters, clock/UUID adapter, configuration | HTTP policy or client-visible business rules |
| Composition root | Constructs adapters/services and mounts routes/middleware | Product behaviour outside wiring |

### 5.2 Server layout

```text
cf-terraform-demos/codeflare/
├── src/
│   ├── client/
│   │   ├── app/
│   │   ├── components/
│   │   ├── composables/
│   │   ├── router/
│   │   ├── services/codeflare-api.ts
│   │   └── views/
│   └── worker/
│       ├── index.ts                    # Worker entry point and composition root
│       ├── routes/
│       ├── middleware/
│       ├── application/
│       │   ├── ports/
│       │   └── repositories/
│       ├── domain/
│       └── infrastructure/
│           ├── artifacts/
│           ├── d1/
│           └── config.ts
├── migrations/
├── infra/
├── tests/
├── cloudflare.config.ts
├── access-policies.ts
└── README.md
```

Vue uses Composition API with `<script setup lang="ts">`. Views compose components and composables;
components receive typed props and emit events; composables own calls through the client API module.
A global store is not required for v1 beyond a small identity/repository refresh state if a real
cross-view need emerges.

### 5.3 Domain ports

The initial ports are intentionally small:

- `RepositoryRegistryPort` — create/list/get/update/delete Codeflare repository records in D1;
- `ArtifactsRepositoryPort` — create/delete/get-info/mint-token for an Artifacts repo name;
- `IdGenerator` and `Clock` — injected deterministic dependencies for pure application tests.

The Artifacts adapter must release repository handles using `using repo = await artifacts.get(name)`
(or explicit disposal where TypeScript/runtime support requires it). Repository capability objects
are disposable RPC handles, not long-lived metadata objects.

### 5.4 Persistence

D1 has one initial table:

```text
repositories(
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  display_name_key TEXT NOT NULL,
  description TEXT NULL,
  artifacts_name TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_email, display_name_key)
)
```

The migration comments must explain why:

- owner identity is an Access email rather than a mutable user id in v1;
- `display_name_key` enforces user-facing per-owner uniqueness;
- Artifacts name is opaque and globally unique in the configured namespace;
- no Git token, remote credential, or authorization role is stored;
- D1 is an ownership/UI registry, not a replacement Git object store.

No KV, R2, Durable Object, Queue, Workflow, AI binding, or Sandbox binding belongs in v1.

### 5.5 Artifacts binding configuration

`cloudflare.config.ts` is the one typed Worker configuration source. It binds:

```ts
ARTIFACTS: bindings.artifacts({ namespace: values.artifactsNamespace })
```

The namespace is deployment-specific and must be read from validated Terraform-output-shaped
configuration in both modes. Since the current `cf`/Miniflare Artifacts implementation uses a remote
proxy rather than a local emulation, local configuration sets `dev: { remote: true }` for the
binding. `pnpm start` therefore requires an authenticated Cloudflare control-plane session and
reaches the designated development Artifacts namespace. The UI and non-Artifacts unit tests remain
offline; normal integration tests use a fake adapter at the port boundary.

The deployment must never bind a production Worker to the development namespace. Use explicit
`artifacts_namespace` output values and separate local/development and production names derived
from the Worker name (for example `${worker_name}-local` and `${worker_name}-prod`), with clearly
documented cleanup ownership.

## 6. Infrastructure, configuration, and lifecycle

### 6.1 Ownership

| Resource or concern | Owner | Reason |
| --- | --- | --- |
| Worker registration, bootstrap version, custom hostname/DNS | Terraform | Requires managed infrastructure lifecycle |
| Cloudflare Access applications and policies | Terraform | Path policy and audience outputs are deployment infrastructure |
| D1 database | Terraform | Durable ownership registry and migration target |
| Artifacts namespaces | `cf artifacts namespaces` scripts | Cloudflare Terraform provider v5 does not provide an Artifacts namespace resource |
| Artifacts repositories/tokens | Worker Artifacts binding | Per-user application data plane/control plane |
| Worker code/static assets/bindings | `cf` + Vite | Deploy-time application upload and configuration |

The namespace scripts must be idempotent. `deploy:artifacts` creates or verifies both namespaces;
`teardown:artifacts` deletes the demo-owned namespaces only after the Worker is deleted and must
handle an already-absent namespace. Namespace cleanup necessarily deletes all contained repositories
and must be clearly documented as destructive.

### 6.2 Terraform and configuration

Terraform reads only the repository-root `.env` through the dotenv provider. It declares a current
Cloudflare provider v5 constraint and outputs documented scalar values:

- `worker_name` and `hostname`;
- `d1_database_id` and `d1_database_name`;
- `access_aud` and `cloudflare_team_domain`;
- `artifacts_namespace` (the production namespace name);
- `environment`.

`infra/local-outputs.json` is committed with safe placeholders matching the output shape. Generated
`infra/outputs.json`, Terraform state, and `.cloudflare/` stay ignored. Types are generated with
`cf workers types --mode development`; generated bindings are included in `tsconfig.json` and never
hand-written.

`.env.example` must add the exact deployment permission required by this demo:

```text
Entire Account → Developer Platform → Artifacts: Edit
```

It retains the existing Workers Scripts, D1, Access, and zone/DNS permissions required by the shared
Terraform lifecycle.

### 6.3 Scripts

`package.json` uses pnpm and `npm-run-all2` namespaced steps. At minimum:

| Script | Behaviour |
| --- | --- |
| `pnpm start` | Ensures the local/demo Artifacts namespace exists, runs local D1 migrations, then starts `cf dev --persist-to .cloudflare/state`. |
| `pnpm check` | Write-free generated-type freshness, strict TypeScript, Oxfmt check, type-aware Oxlint, Terraform validate/fmt check, and architecture/security contract tests. |
| `pnpm fix` | Generates types/config as required, runs Oxfmt write, safe lint fixes, and Terraform format. |
| `pnpm test` | Runs domain/application, adapter, Vue DOM, and offline Workers-runtime integration projects. |
| `pnpm deploy` | Creates/verifies Artifacts namespaces, applies Terraform, writes outputs, runs remote D1 migration, builds Vite output, then uploads using `cf deploy --prebuilt`. |
| `pnpm teardown` | Deletes the deployed Worker first, deletes demo-owned Artifacts namespaces, then destroys Terraform infrastructure. |

`pnpm check` never creates an Artifacts namespace, changes a remote resource, runs a migration, or
writes generated files. `pnpm deploy` and `pnpm teardown` are non-interactive and idempotent.

## 7. Quality, testing, accessibility, and observability

### 7.1 Required testing

| Layer | Required evidence |
| --- | --- |
| Domain | Display-name/description/token-request validation and canonicalisation; opaque name generation; problem mapping. |
| Application | Owner isolation, create compensation after D1 failure, delete ordering/failure behaviour, and no plaintext token retention. |
| D1 adapter | Owner-scoped list/get/update/delete and duplicate-name constraint mapping. |
| Artifacts adapter | Correct `create`, `get`, `info`, token scope/TTL, `delete`, and disposable-handle lifecycle against fake binding capabilities. |
| Routes | JSON/media/origin rejection, RFC 9457 errors, response projection, and no actor taken from input. |
| Vue DOM | Empty/list/error states, creation validation, repository navigation, token disclosure/copy/clear behaviour, keyboard use, and accessible announcements. |
| Workers runtime | Finite-timeout Access audience checks, anonymous rejection, cross-user uniform `404`, and mutation constraints. Artifacts is replaced at the application port boundary so the suite stays offline. |
| Manual live validation | A separately named, opt-in operator runbook: create repository, mint read and write tokens, clone/fetch/push with standard Git, verify expiry/scope, delete repository, and verify teardown removes the namespace. |

Every Workers-runtime integration project defines finite `testTimeout` and `hookTimeout`. Test suites
must not require a live account or Artifacts remote service.

### 7.2 Accessibility requirements

- Semantic landmarks, one visible page heading, logical heading hierarchy, visible focus, and
  keyboard-operable navigation/actions.
- Native labelled form controls; errors linked with `aria-describedby`; status updates announced
  without moving focus unexpectedly.
- Dialog focus trap, Escape/cancel closure, focus restoration, and at least 24px interactive targets.
- Token handling that is understandable to a screen-reader user: scope, expiration, one-time
  plaintext warning, and copy success/failure all have text equivalents.
- Responsive layout works at narrow widths without horizontal loss of controls or reliance on hover.
- Colour is never the sole indication of status, permission, or an error.

### 7.3 Acceptance conditions

v1 is complete only when:

1. A clean checkout with only root `.env` configured can run `pnpm start`, render the public landing
   page, authenticate through local Access emulation, and use the real remote Artifacts binding in
   the documented local namespace.
2. `pnpm check` and `pnpm test` pass without live infrastructure or network-dependent tests.
3. `pnpm deploy` then `pnpm teardown` are idempotent and leave no Worker, D1 database, Access
   resources, custom hostname, or demo-owned Artifacts namespace behind.
4. A verified actor can create, list, read, edit metadata for, mint a token for, and delete only
   their own repository; another actor always receives the same non-enumerating `404` as for an
   absent id.
5. A real live validation proves a read token can clone/fetch/pull, a write token can push, token
   scope is enforced, and token expiry is visible to the user.
6. No plaintext Artifacts token reaches D1, KV, logs, analytics, browser persistent storage, route
   state, or any response other than the immediate mint response.
7. Every protected Worker API validates the intended Access audience and every mutation validates
   origin and JSON content type.
8. The UI has accessible, tested loading, empty, validation-error, operational-error, and success
   states at desktop and narrow widths.
9. The README documents prerequisites, API-token permission, local remote-binding caveat, commands,
   Git token safety, Artifacts limits (1 GB/repository and 32 MB/blob at time of writing), and v1's
   deliberate scope boundary.
