# Ignite CRM

A small-business CRM built as **two Cloudflare Workers**: a public Application Worker (Vue SPA +
Hono API) and a private Data Worker (CRM, Projects, Notes, and Permissions modules over one D1
database), connected only by a typed Workers RPC service binding.

The product scope is in
[`specs/ignite-crm/00-introduction.md`](../../specs/ignite-crm/00-introduction.md), the engineering
design in [`01-specification.md`](../../specs/ignite-crm/01-specification.md), and the delivery plan
in [`02-implementation.md`](../../specs/ignite-crm/02-implementation.md). Decisions made during
implementation are recorded in [`03-follow-ons.md`](../../specs/ignite-crm/03-follow-ons.md).

**Status: first release (Phases 1–7 complete).** Customer context, sales, won-deal conversion to
delivery, multi-linked notes and search, team administration and audit, and pipeline and delivery
reports, in a responsive, keyboard-operable SPA that passes an automated WCAG 2.2 AA scan in both
themes. The Phase 7 review and its per-finding status are in
[`04-mvp-review.md`](../../specs/ignite-crm/04-mvp-review.md); a guided end-to-end walkthrough is in
[`DEMO.md`](./DEMO.md).

**Quick review:** `pnpm install` at the repository root, then `pnpm start` here and sign in as
`owner@example.com`. Open a contact (customer overview and timeline), a deal (**Mark won/lost**
converts it into a project), the project's task board, **Notes**, **Team**, **Audit trail**, and
**Reports**.

## Architecture

```text
Browser (Vue 3 + Vuetify SPA)
   │  same-origin HTTPS, Cloudflare Access
   ▼
ignite-crm-application  ── Access JWT verification, same-origin/JSON protections, RFC 9457,
   │                        request ids, shared-schema validation of input AND output
   │  DATA_SERVICE (Workers RPC service binding — the only route to data)
   ▼
ignite-crm-data         ── DataEntrypoint → application services → repository ports → D1 adapter
   │
   ▼
D1 (one database: permissions, CRM, audit, idempotency tables)
```

Four tiers, one direction:
`client → Application API → Data Worker application/domain → infrastructure`.

| Path                             | Tier                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| `src/client`                     | UI: Vue SPA, typed API client, Vuetify                     |
| `src/application-worker`         | API: Hono routes, Access, protections, RPC client          |
| `src/data-worker/application`    | Use cases: validation, authorization, idempotency, audit   |
| `src/data-worker/domain`         | Pure rules (no I/O)                                        |
| `src/data-worker/infrastructure` | D1 port and repositories (all SQL lives here)              |
| `src/shared`                     | Runtime-neutral Valibot schemas, RPC contract, error codes |
| `src/configuration.ts`           | Installation settings (UK defaults), validated at start    |

### Why a modular monolith inside one RPC microservice

The Data Worker's modules are structured as if they were separate services (each has its own ports
and use cases), but they share one D1 database and transaction boundary. That keeps the deployment
small and free-tier friendly, and makes cross-module workflows (deal → project conversion,
multi-linked notes) **atomic** instead of a distributed saga. The earlier seven-Worker design is
kept for comparison in `specs/ignite-crm/microservice-experiment/`.

### The RPC contract

`src/shared/data-service/contract.ts` defines the one grouped contract. `DataEntrypoint` exposes
`health`, `resolveActor`, `resolveUser`, `authorize`, and module targets `crm()`, `projects()`,
`notes()`, and `permissions()` (methods, not getters, so `env.DATA_SERVICE.crm().getContact(...)`
pipelines into one round trip).

Composite views are assembled in the Application Worker, not the Data Worker: the customer overview
(`src/application-worker/overview/customer-overview.ts`) issues two bounded RPC reads in parallel —
the core contact/company detail and the first page of linked notes. Only the notes section is
optional: a retryable notes failure returns the page with `notes: null` and an explicit warning,
while any authorization failure, and any core failure, fails the whole request. An authorization
decision is never disguised as missing data.

Every RPC method resolves to an envelope, `{ ok: true, value } | { ok: false, error }`, rather than
throwing. Expected failures (forbidden, not found, conflict) are ordinary outcomes for a data
service; as values they stay out of the runtime's uncaught-exception logs and their shape does not
depend on RPC error reconstruction. `src/application-worker/data-client.ts` converts the envelope
back into a throwing API and maps transport failures and timeouts to a retryable
`DEPENDENCY_FAILURE` (HTTP 503) whose detail is logged, never returned.

### D1 transactions

D1 has no interactive transactions; `batch()` is atomic but its statements cannot branch on each
other's results. The D1 port (`src/data-worker/infrastructure/d1/d1-port.ts`) models a transaction
as **read, then commit one atomic write set**. Commit-time invariants (expected version, a
referenced row still exists) are queued as **guards**: an `INSERT` into the `tx_guard` view whose
`INSTEAD OF` trigger raises when the precondition is false, aborting and rolling back the whole
batch with a reportable reason. That is compare-and-swap inside the transaction.

### Idempotency and versioning

Every mutation requires `Idempotency-Key`. The same key with the same canonical request returns the
original result (checked **before** the version check, so a retry after a lost response succeeds
even though its `If-Match` is now stale); the same key with a different request is
`409 IDEMPOTENCY_KEY_REUSED`. Records are kept for 24 hours. Updates require `If-Match: "<version>"`
and fail with `409 VERSION_MISMATCH` when stale. Audit events and the idempotency record commit in
the same write set as the business change.

## Security model

- **Cloudflare Access** gates the whole hostname at the edge (any identity in the team's IdPs).
- The Application Worker **re-verifies the Access JWT and its exact audience** on every `/api`
  request (`@demos/worker-common`'s `createAccessMiddleware`). Development tokens are only accepted
  when `import.meta.env.DEV` — statically `false` in production builds.
- Identity is taken **only** from the verified JWT. Client copies of edge identity headers are
  deleted by one named function (`withoutIdentityHeaders`) before Access verification, and request
  bodies are `strictObject` schemas, so an `ownerId` cannot be smuggled in.
- **RBAC in the Data Worker**: every use case asks the Permissions module to authorize; the SPA's
  capability hints only hide controls. Permission storage failures fail closed (503, retryable).
- **Bootstrap owner**: the root `.env` `ADMIN_EMAIL` becomes owner on first sign-in. Any other
  Access identity is provisioned as **read-only** on first sign-in.
- Mutations require a same-origin `Origin`/`Sec-Fetch-Site` and an `application/json` body (CSRF
  defence for cookie-borne Access sessions); bodies are limited to 8 KiB.
- The Data Worker has no domain, no workers.dev route, and `fetch()` returns 404.
- All SQL is constant text with bound parameters; search escapes `LIKE` wildcards.
- Errors are RFC 9457 `application/problem+json` with a stable `code`, `requestId`, and `retryable`;
  internal errors never leak detail or stacks in production.
- **Security headers.** Every API response carries `Content-Security-Policy: default-src 'none'`,
  `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`.
  The SPA's assets get a page CSP (`script-src 'self'`; inline styles allowed for Vuetify's runtime
  theme) from `public/_headers`. `tests/e2e/csp.spec.ts` renders the SPA under that exact policy
  with no violations. Enable HSTS on the zone (SSL/TLS → Edge Certificates); it is not an asset
  header.
- **Expired sessions.** When Access redirects an expired session's API call to its login page, the
  SPA says "Please sign in again" and offers a reload rather than a misleading retry.
- **Access breadth (accepted).** Any identity the team's IdPs can authenticate is admitted, then
  provisioned read-only. For a real deployment, restrict the Access policy in `infra/access.tf` to
  your email domain or an Access group.

## Prerequisites

- Node 24+, pnpm 12, Terraform ≥ 1.10.
- The repository-root `.env` (`pnpm create-env` at the repository root). See `.env.example` for the
  API-token permissions: D1 Edit, Workers Scripts Edit, Access Edit, and DNS Edit on the zone.

## Commands

Run from this directory after `pnpm install` at the repository root.

| Command         | What it does                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pnpm start`    | `migrate:local` → `seed:local` → `cf dev` (`vite.config.ts` persists to `.cloudflare/state`)                                  |
| `pnpm check`    | Types for both Workers, `tsc` (app + Workers-runtime tests), Oxfmt, type-aware Oxlint, Terraform init/validate/fmt, dev build |
| `pnpm fix`      | Regenerate types, Oxfmt write, Oxlint `--fix`, `terraform fmt`                                                                |
| `pnpm test`     | All Vitest projects **with Istanbul coverage** (80% gate on all metrics), then the offline Playwright journeys                |
| `pnpm deploy`   | Terraform apply → `infra/outputs.json` → remote migrations → production build → deploy Data, then Application                 |
| `pnpm teardown` | Delete Application, then Data Worker, then `terraform destroy`                                                                |

Each step is individually runnable (`pnpm deploy:infra`, `pnpm teardown:worker:data`,
`pnpm test:vitest`, `pnpm test:e2e`, …). `pnpm check:bundles` builds the SPA and both Workers and
records their sizes (see [Bundle sizes](#bundle-sizes)).

### Local development identities

`pnpm start` serves a local Access login page with one identity per seeded role. They exist only in
the local seed (`migrations/seed/9001_local_seed.sql`) — never in a deployed database.

| Identity               | Role                             |
| ---------------------- | -------------------------------- |
| `owner@example.com`    | Owner (also local `admin_email`) |
| `manager@example.com`  | Manager                          |
| `sales@example.com`    | Sales representative             |
| `delivery@example.com` | Delivery contributor             |
| `readonly@example.com` | Read-only                        |

The local seed (`9001_local_seed.sql` for users/contacts and `9002_local_sales_seed.sql` for sales
records) is shaped as a migration in its own directory because `cf d1 query` has no local mode; the
repository migration helper applies it with `--local` only.

## Tests and coverage

| Project       | Runs in        | Covers                                                                                                                                             |
| ------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit`        | Node           | Schemas, domain, use cases over in-memory ports, Hono app over the fake                                                                            |
| `client`      | jsdom          | API client, views and components with a real `createVuetify()`                                                                                     |
| `contract`    | Node           | Shared Data Worker contract suite against the in-memory fake                                                                                       |
| `integration` | workerd (30 s) | Same contract suite against the real `DataEntrypoint` over RPC + D1, D1 port guards, full system journeys, the chat agent in a real Durable Object |
| `e2e`         | Chromium       | Playwright: both Workers under `cf dev`, local D1, local Access login, desktop and mobile (90 s per test): journeys, axe WCAG 2.2 AA, CSP          |

The fake Data Worker (`tests/fakes`) composes the **real** application services and SQL repositories
with an in-memory SQLite port, and passes the same contract suite as the real one. In the
integration project the Application Worker reaches `DataEntrypoint` through a genuine service
binding, so values cross a real RPC serialization boundary.

Istanbul measures every file under `src/**/*.{ts,vue}`; only tests and declaration files are
excluded. The report is written to `coverage/`.

**No test calls Workers AI.** The chat suites drive the real agent, the real Durable Object, and the
real tool path with a deterministic model (`tests/integration/fake-model.ts`) that implements the AI
SDK's provider interface: they assert the turn loop, the tools, and the permissions, never the
prose. The allowance is finite and a model's output is not reproducible, so a test that depended on
either would be flaky and expensive.

Two Vitest projects run Worker code outside workerd — the Hono app under Node, and the SPA's `fetch`
served from it under jsdom — and since the chat feature that import graph reaches modules only
workerd provides. `tests/workers-aliases.ts` substitutes exactly those, and the stubs throw if
called, so nothing a test actually exercises is faked.

The Playwright journeys (`tests/e2e`, `playwright.config.ts`) run offline. `scripts/e2e-server.ts`
recreates a dedicated `.cloudflare/e2e-state`, applies the data and local seed migrations, and
starts `cf dev` on port 5199. `vite.config.ts` selects that directory using `IGNITE_PERSIST_TO`, so
the dev server opens the same database the migrations wrote without touching your `pnpm start` data.
The journeys cover identity → contact/company → deal/activity → win and convert → task (moved with
the keyboard status menu) → multi-linked note and search → customer timeline → audit → reports, an
owner changing a teammate's role, the assistant answering from CRM data and writing only after an
approval (plus a declined change that does not happen), and keyboard skip-link/navigation focus,
each at 1440 × 900 and on a Pixel 7. The browser is the Chromium build bundled with
`@playwright/test` (`pnpm exec playwright install chromium` once on a new machine).

## Configuration

`src/configuration.ts` holds the installation settings (`GB`, `en-GB`, `Europe/London`, `GBP`, `£`,
medium dates, Monday week start). Edit `DEFAULT_CONFIGURATION` to localise an installation. The SPA
receives only the display DTO from `GET /api/v1/configuration`.

## Vuetify component library

The SPA is built entirely from Vuetify. Components are registered by name in
`src/client/vuetify.ts`, with one light/dark theme as the single source of colour and density. The
palette is built on Cloudflare orange `#FC7C1E` (primary) and `#5A73F4` (secondary). Each has
AA-compliant `*-strong` tones for text and focus, plus `*-container` fills. Registration lists
exactly the components the templates use; `tests/client/vuetify-registration.test.ts` fails if the
two drift apart.

### Custom components and why each exists

Every file in `src/client/components` is composed from Vuetify primitives and theme tokens only, and
is exercised in the light and dark themes (`tests/client/component-api.test.ts`,
`tests/client/theme.test.ts`). Most are thin, domain-specific compositions (forms and lists such as
`ContactForm`, `DealForm`, `TaskForm`, `TeamMemberForm`, `ActivityList`, `DealList`, `NoteList`,
`HistoryList`, `ResourceState`) rather than new controls. The reviewed **exceptions** — places where
Vuetify has no suitable component — are:

| Component           | Why Vuetify alone is not enough                                                                                          | Built from                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `PipelineBoard`     | No kanban board. Drag/drop is replaced by a keyboard-first stage menu.                                                   | `VRow`/`VCol`/`VCard`, `VMenu`, `VList`             |
| `TaskBoard`         | No kanban board; fixed task statuses with a keyboard status menu.                                                        | `VRow`/`VCol`/`VCard`, `VChip`, `VMenu`             |
| `ActionStreamRow`   | A worklist row with urgency, contact/deal/company links, and an optional Done action.                                    | `VListItem`, `VChip`, `VBtn`                        |
| `ContactPicker`     | `VAutocomplete` alone has no explicit, keyboard-operable "Add" for remote results.                                       | `VTextField`, `VAutocomplete`, `VList`, `VBtn`      |
| `RecordLinkChooser` | No chooser across several record types.                                                                                  | `VSelect`, `VTextField`, `VList`, closable `VChip`s |
| `MarkdownComposer`  | Write/Preview switch with a UTF-8 byte counter.                                                                          | `VTextarea`, `VBtnToggle`                           |
| `MarkdownView`      | No Markdown renderer. The one `v-html` in the SPA, fed only by the sanitising renderer; shows a skeleton while it loads. | `VSkeletonLoader`, `VAlert`, theme tokens           |

`CustomerTimeline` (Phase 6) is not an exception: it is Vuetify's own `VTimeline` with per-kind
icons and theme colours.

## Phase 2: sales workflow

The migration `migrations/data/0002_sales.sql` adds the fixed four-stage pipeline, deals,
activities/links, and contact next actions. `migrations/seed/9002_local_sales_seed.sql` adds sample
deals, a two-contact meeting, and follow-ups only to **local** development; it is never applied to a
deployed database. A contact can be the primary contact for a deal without becoming the company's
primary contact. A call or meeting belongs to every linked contact, its optional company and its
optional deal; history is discoverable from each context. Timelines are bounded (50 deals and 50
activities per record) and use a fixed number of D1 queries, not an RPC per row.

The Data Worker owns every sales rule and validates every link again inside a guarded atomic D1
batch. Mutations write business rows, audit metadata, and idempotency results together. Deals carry
a fixed `pending|won|lost` outcome for reporting and a separate, human-only status line; amounts are
integer pence. An update needs `If-Match: "<version>"`, a mutation needs `Idempotency-Key`, and a
409 preserves the editor's draft. Any explicit deal owner assignment needs `crm.assign` (owner or
manager), even if the owner is unchanged; ordinary `crm.write` is not enough.

The Action Stream merges the signed-in user's open contact next actions and pending deals with next
actions, ordered ASAP → overdue → today → upcoming using the installation's time zone. A contact has
at most one open action; a completed action stays in history. Reports show bounded pipeline totals
by stage and outcome, guarded by `report.read`. The SPA exposes `/actions`, `/deals`, and
`/deals/:id` alongside the contact/company timelines. The sales journey is: open a contact → New
deal → set a dated next action → log a meeting with two contacts → open either contact, its company,
or the deal to find the meeting → open Action stream to chase the work.

The SPA uses only Vuetify primitives. Two reusable compositions are the exceptions Vuetify does not
directly supply: `ActionStreamRow` (`VListItem` + urgency chip, contact/deal links, optional Done
action) and `PipelineBoard` (responsive `VRow`/`VCard` columns with a keyboard-operable stage menu
instead of drag-and-drop). Both have their own DOM tests. The multi-contact picker adds a labelled
search field and explicit keyboard-operable Add buttons to Vuetify's chips and autocomplete. The
fake Data Worker for unit/client tests runs the **production** repositories and services over an
in-memory SQLite port with the committed migrations; the shared contract suite also runs against
real Workers RPC+D1.

### Phase 2 API additions

| Route                                                   | Purpose                                                 |
| ------------------------------------------------------- | ------------------------------------------------------- |
| `GET /api/v1/pipeline`, `GET /api/v1/assignees`         | Pipeline stages and active users                        |
| `GET/POST /api/v1/deals`, `GET/PATCH /api/v1/deals/:id` | Search, create, read, and versioned edit                |
| `POST /api/v1/activities`                               | Log a multi-linked call or meeting                      |
| `PUT /api/v1/contacts/:id/next-action`                  | Create or versioned replace (omit `If-Match` to create) |
| `POST /api/v1/contacts/:id/next-action/complete`        | Versioned completion                                    |
| `GET /api/v1/action-stream`                             | Signed-in actor's prioritized worklist                  |
| `GET /api/v1/reports/pipeline`                          | Bounded stage/outcome totals                            |

All reads require verified Access identity and the Data Worker's authorization. The routes parse
shared Valibot schemas before RPC and check response schemas afterwards; every HTTP failure uses RFC
9457 problem details.

## Phase 3: delivery workflow

`migrations/data/0003_projects.sql` adds projects, tasks, conversion records, and the deal's project
back-link. `migrations/seed/9003_local_delivery_seed.sql` adds one already-converted project with
tasks and another won deal ready for review **only in local development**. To see the increment:
sign in as Sales, open the won Contoso analytics rollout deal, choose **Convert to project**, and
confirm. The result opens the linked project; the deal, contact, and company pages also show the
delivery link. Sign in as Delivery to add and progress tasks on the project and see assigned tasks
under **My work**. Read-only users see those records but no mutation controls.

A deal's pipeline **stage** and its **outcome** are separate: moving a deal through the stages never
wins it. To close an open deal, choose **Mark won/lost** on the deal page. The dialog defaults to
**Won** with **Also convert to a delivery project** checked; submitting then wins the deal, creates
the project, and links them in one Data Worker transaction (`POST /deals/:id/convert` with
`markWon: true`), so a failure leaves the deal open rather than won but unconverted. Unchecking
conversion only wins the deal (it can be converted later with **Convert to project**). Choosing
**Lost** greys out the conversion option and only closes the deal. Closing clears the next action
and records when the deal closed.

The Data Worker converts a won deal in **one D1 batch**: it checks the deal's version and status,
inserts the project and a completed conversion record, links the deal, writes audit events and the
idempotency result, and commits. Any failed guard or storage statement rolls all of it back; there
is no pending/saga state or retry-link endpoint. The unit suite injects a failure at every statement
of the write set, and a Workers-runtime test proves the same rollback on real D1. Conversion uses
`deal.convert` (Sales, Manager, Owner) and needs `If-Match: "<deal version>"` plus
`Idempotency-Key`; a second conversion returns 409. The converted deal must remain won.

Project/task reads require `project.read` (all seeded roles). Task and ordinary project edits need
`project.write` (Delivery, Manager, Owner). Archiving/unarchiving a project or changing its lead
also requires `project.manage` (Manager, Owner); archived projects stay readable but no tasks can be
changed. Tasks have fixed `todo|in_progress|in_review|done` statuses and
`no_priority|low|medium|high|urgent` priorities. Completing a task stamps its completion instant;
reopening clears it. The project board and `/my-work` show overdue dates relative to the
installation time zone. All task/project updates use `If-Match` and preserve the editor's draft on
409; after reloading, untouched fields keep the other person's changes.

The reusable `TaskBoard` is the Phase 3 Vuetify exception: Vuetify has no kanban board. It composes
responsive `VRow`/`VCard` columns, `VChip` priorities, and a keyboard-operable `VMenu` for status
changes. A task table is available alongside it. There is no drag/drop path with an inaccessible
alternative; the menu is the primary interaction. It has its own DOM tests. `TaskForm`,
`ProjectList`, and My Work compose standard Vuetify primitives.

### Phase 3 API additions

| Route                                                        | Purpose                                               |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| `POST /api/v1/deals/:id/convert`                             | Atomic conversion of a won deal to a linked project   |
| `GET /api/v1/projects`, `GET/PATCH /api/v1/projects/:id`     | Search, read with tasks/history, and versioned edit   |
| `POST /api/v1/projects/:id/tasks`, `PATCH /api/v1/tasks/:id` | Create and versioned update/move tasks                |
| `GET /api/v1/my-work`                                        | Signed-in actor's open assigned tasks across projects |

## Phase 4: multi-linked notes and search

`migrations/data/0004_notes.sql` adds `notes`, the typed `note_links` join table, and an FTS5
external-content index (`notes_fts`) maintained by triggers.
`migrations/seed/9004_local_notes_seed.sql` adds two sample notes **only in local development**. To
see the increment: open the Northwind onboarding workshop project (or either Northwind contact,
Northwind Traders, or the onboarding deal) and find **Onboarding workshop planning** in its
**Notes** card — the same note on all five pages. Choose **Notes** in the navigation and search for
`workshop`. To write one, choose **New note** on any record page: the note starts linked to that
record, and the link chooser adds contacts, companies, deals, and projects.

A note is one canonical Markdown document with **one or more** typed links; it is not a CRM activity
and has no single parent. The Data Worker validates every new link target against the same snapshot,
then writes the note, all of its links, the audit event, and the idempotency result in one D1 batch.
A commit-time guard re-checks that each new target still exists, so a record deleted between
validation and commit rolls the whole note back. The FTS triggers run inside that batch, so a
rolled-back note is never searchable. The unit suite fails the write set at every statement; a
Workers-runtime test proves the same rollback, and the FTS triggers, on real D1.

- **Rules.** Title 1–200 characters; body 1 byte–64 KiB of UTF-8 after newline normalization; 1–20
  links; duplicate links are refused with the duplicate's index (`links.2`). A link whose target is
  later deleted is kept and shown as a tombstone ("Project · deleted"); re-adding a deleted record
  is refused.
- **Permissions.** `note.read` reads, lists, and searches (every seeded role). `note.write` creates
  notes (Sales, Delivery, Manager, Owner) and also needs read access to each linked record type
  (`crm.read`, or `project.read` for projects). An author edits their own notes; editing another
  user's note needs `note.manage` (Manager, Owner).
- **Search.** `POST /api/v1/notes/search` with `{ "q": "…" }` (2–200 characters). Search text is
  note content in all but name, so it travels in a body rather than the URL — it stays out of
  browser history, `Referer` headers, and request logs, and the SPA does not put it in the address
  bar either. The text is split into letter/digit tokens, each becomes a quoted prefix term, and the
  terms are ANDed; no client FTS syntax ever reaches `MATCH`. Diacritics fold (`cafe` finds `café`).
  Results are ranked by BM25 (title matches weigh 5×), then most recently updated, capped at 50,
  with a `truncated` flag. Snippets are returned as plain-text runs and highlighted with `<mark>` by
  ordinary text interpolation. Linked-record feeds (`GET /api/v1/notes?linkType=&linkId=`) use the
  reverse link index, not FTS.
- **Audit.** Audit rows hold a SHA-256 digest of the body, link counts, and added/removed link ids —
  never the note text or customer names.
- **Markdown.** Raw Markdown is stored; HTML is never stored. The SPA renders headings, emphasis,
  strikethrough, lists, read-only task-list checkboxes, block quotes, code, tables, and links.
  **HTML is disabled**: tags are shown as text. Images render as their alt text (no remote fetches
  from a shared note). A link renders only for `http:`, `https:`, `mailto:`, or a relative URL, and
  external links open with `rel="noopener noreferrer nofollow"`. `src/client/services/markdown.ts`
  is the one place Markdown becomes HTML; its output also passes through a strict DOMPurify
  allowlist, so a parser bug cannot become script injection. `MarkdownView` is the SPA's only
  `v-html`.
- **Partial failure.** Each record page loads its Notes card independently; if the feed fails, the
  card shows a retryable warning and the record itself stays usable.

Phase 4 adds three reviewed Vuetify exceptions, each in `src/client/components` with its own DOM
tests and no API calls of its own:

- `RecordLinkChooser` — Vuetify has no chooser across several record types (`VAutocomplete` mixes
  result kinds in one list with no way to say which kind to look for). It composes a `VSelect` for
  the type, a `VTextField` search, a `VList` of results with labelled **Add** buttons, and closable
  `VChip`s whose close buttons are labelled ("Remove Northwind Traders"). Enter in the search adds
  the first result. The parent performs searches through its `search` event.
- `MarkdownComposer` — a `VTextarea` (labels, counter, errors, and focus are Vuetify's own) with a
  `VBtnToggle` Write/Preview switch and a UTF-8 byte counter against the 64 KiB limit.
- `MarkdownView` — sanitised, read-only Markdown in Vuetify typography and theme tokens, exposed as
  a labelled region.

`NoteForm`, `NoteList`, `NotesCard`, and the Notes and Note pages compose standard Vuetify
primitives. Two runtime dependencies are added for rendering, pinned exactly and already used by a
sibling demo: `marked` (parser) and `dompurify` (sanitiser).

### Phase 4 API additions

| Route                                              | Purpose                                                         |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/v1/notes`                                | Newest-first notes; `linkType` + `linkId` for one record's feed |
| `POST /api/v1/notes/search`                        | Bounded full-text search (`{ q }` body; read-only, no key)      |
| `POST /api/v1/notes`                               | Atomic create with all links (`Idempotency-Key`)                |
| `GET /api/v1/notes/:id`, `PATCH /api/v1/notes/:id` | Read with history; versioned text edit and/or link replacement  |

Note bodies may be up to 512 KiB on the wire (JSON escaping can grow 64 KiB of text); every other
JSON endpoint keeps the 8 KiB default.

## Phase 5: team administration, roles, and audit

`migrations/data/0005_team.sql` adds a `users.read` permission (owner and manager), records who
granted each role, and indexes the team directory and the audit viewer's filters. There are no new
tables: users, the fixed seeded roles, and `audit_events` already existed. To see the increment,
sign in as `owner@example.com` and open **Team**: add a teammate (any e-mail, for example
`pat@example.com`) as Read-only, then sign in as that identity in another browser profile and note
that **New contact** is absent and the API refuses writes. As the owner, choose **Roles** and make
them a Manager; on the teammate's very next page load the **Audit trail** appears and the server
accepts their requests. Open **Audit trail** to filter by area, record type, or person.

- **Who can do what.** Owners invite, change roles, and suspend or reactivate (`users.manage`,
  `roles.assign`). Managers read the team directory and the audit trail (`users.read`,
  `audit.read`). Everyone else sees neither; the navigation hides both, and the API answers `403` if
  they ask anyway. `tests/unit/permissions/role-matrix.test.ts` is an explicit, hand-written role ×
  operation fixture that runs every critical CRM, project, notes, reporting, administration, and
  audit operation as every role.
- **Invitation.** Adding a teammate pre-creates their Access identity with its roles; no e-mail is
  sent, and Cloudflare Access still decides who can authenticate at all. Their first sign-in finds
  the record and uses those roles. A duplicate e-mail is a `409` naming the field. Unknown
  identities that sign in without an invitation are still auto-provisioned read-only (Phase 1).
- **Immediate effect.** Nothing caches roles: every authorization reads `user_roles` and
  `role_permissions` afresh, so a role change or suspension applies to the teammate's next request
  with no sign-out. The SPA's capability hints load once per page, and refresh at once when an owner
  edits their own roles.
- **Safety rules.** Role and status changes need `If-Match` (version) and `Idempotency-Key`. An
  active user always has at least one role. At least one active owner always remains: the write set
  ends with a guard that counts active owners _after_ the change inside the same D1 batch, so two
  owners demoting each other at once cannot both succeed (proven on real D1 in
  `tests/integration/data-worker/team.test.ts`). An owner cannot suspend themselves.
- **Audit.** `GET /api/v1/audit` reads the one shared `audit_events` table, newest first, with a
  keyset cursor and optional `module`, `entityType`, `entityId`, and `actorId` filters. Each event
  shows the record's current name, the actor, the request id, and **allowlisted** metadata only —
  ids, field names, statuses, counts, and content digests. The allowlist is applied when the event
  leaves the Data Worker (`src/data-worker/domain/audit/audit.ts`), so even a future writer that
  stores an unexpected key cannot leak it; such events are flagged "redacted". A note appears as its
  title and a SHA-256 digest of its body, never its text.

The Team and Audit pages use Vuetify's `VDataTable`, `VSelect`, `VCheckbox`, `VDialog`, and `VChip`.
`TeamMemberForm` is a composition of those standard form primitives, not a new control.

### Phase 5 API additions

| Route                          | Purpose                                               |
| ------------------------------ | ----------------------------------------------------- |
| `GET /api/v1/roles`            | The fixed role catalogue with each role's permissions |
| `GET /api/v1/users`            | Team directory (`q`, `cursor`); owner and manager     |
| `POST /api/v1/users`           | Add a teammate with roles (owner; `Idempotency-Key`)  |
| `PUT /api/v1/users/:id/roles`  | Replace roles (owner; `If-Match`, `Idempotency-Key`)  |
| `PUT /api/v1/users/:id/status` | Suspend or reactivate (owner; `If-Match`)             |
| `GET /api/v1/audit`            | Filtered, newest-first audit trail; owner and manager |

## Phase 6: reports, customer overview, and a release-ready SPA

- **Reports** (`/reports`, every role with `report.read`). The pipeline report shows open deals and
  value by stage plus won and lost, filterable by deal owner and by a close-date window (at most 366
  days, inclusive dates in the installation time zone; the window narrows won/lost only, because an
  open deal has no close date). The delivery report shows task counts by status and overdue tasks
  across active, on-hold, or completed projects, optionally for one project lead, with up to 50
  per-project rows (totals always include every project). Filters live in the URL, and each report
  loads and fails independently. Archived projects are history, so they are not a delivery option.
- **Customer overview.** Contact and company pages now load one composite response with a merged,
  newest-first **Timeline** (calls and meetings, deals opened/won/lost, projects started, notes) —
  titles only, never activity summaries, deal status lines, or note bodies. If notes are briefly
  unavailable the Notes card says so and offers Retry; the rest of the page renders.
- **Faster first load.** Every view except the dashboard is a lazily loaded route chunk, and the
  Markdown libraries (`marked`, `dompurify`) load only when a note body or preview is first shown
  (`src/client/services/markdown.ts` remains the single Markdown boundary; the safety tests run
  through the lazy path). A thin progress bar shows while a view's chunk downloads, the note body
  shows a busy skeleton, and a chunk that cannot be fetched (typically just after a deploy) offers
  **Reload** instead of failing silently. The previous 500 kB build warning is resolved, not
  suppressed.

### Phase 6 API additions

| Route                                | Purpose                                                              |
| ------------------------------------ | -------------------------------------------------------------------- |
| `GET /api/v1/reports/pipeline`       | Pipeline report; optional `ownerId`, `closedFrom`, `closedTo`        |
| `GET /api/v1/reports/delivery`       | Delivery report; optional `projectStatus` (default active), `leadId` |
| `GET /api/v1/contacts/:id/overview`  | Contact overview: detail, first notes page, timeline, warnings       |
| `GET /api/v1/companies/:id/overview` | Company overview, same shape                                         |

With no query string, `/reports/pipeline` is the whole-pipeline summary the dashboard shows.

## Bundle sizes

Recorded with `pnpm check:bundles`. The figures are observational, with one exception: the chat
panel's budget is **enforced**, because "a user who never opens chat downloads none of it" is easy
to lose by accident and impossible to notice in a size table (see
[AI chat agent](#bundle-cost-none-unless-opened)). It builds in a `bundles` mode that reads the
committed placeholder outputs, so it runs in a clean checkout; the emitted code is the same as a
production build. The full per-file report is written to the ignored
`.cloudflare/bundle-report.json`.

| Artifact                    | After Phase 6 | Release (Phase 7) | With AI features | gzip (current) |
| --------------------------- | ------------: | ----------------: | ---------------: | -------------: |
| SPA entry chunk             |      427.8 kB |          428.5 kB |         436.9 kB |       142.6 kB |
| SPA JavaScript (all chunks) |      768.3 kB |          772.6 kB |       1 207.4 kB |       385.2 kB |
| `markdown-renderer` chunk   |       74.9 kB |           75.0 kB |          74.7 kB |        25.2 kB |
| `ChatPanel` chunk (lazy)    |             — |                 — |         279.8 kB |        77.4 kB |
| SPA CSS                     |      374.4 kB |          375.1 kB |         376.0 kB |        51.4 kB |
| Application Worker          |      305.6 kB |          307.8 kB |       3 958.5 kB |       929.7 kB |
| Data Worker                 |      287.1 kB |          287.3 kB |         526.0 kB |       110.9 kB |

The entry chunk is what every first visit downloads, and it grew by about 3 kB for the AI features —
the app-bar toggle and the loading boundary, nothing more. The panel's own 280 kB arrives only when
somebody opens it.

The Application Worker grew an order of magnitude, which is worth being plain about: it now carries
the Agents SDK, the AI SDK, the MCP server, and the Workers AI provider. That is Worker code, not
something a browser downloads, and it is within the 10 MB compressed Workers limit with room to
spare — but it is the real cost of putting two agent surfaces in one Worker, and a reader sizing
their own should expect it. `pnpm check` enforces both the initial-entry budget and a 100 kB gzipped
ceiling for the lazy `ChatPanel` chunk; `pnpm report:bundles` additionally writes the ignored JSON
artifact when a release needs saved figures.

## AI chat agent

A **Chat** button in the app bar opens the assistant in a right-hand panel. It answers questions
about this installation's CRM data and can change it, within exactly the authority the signed-in
user already has.

### Endpoints

| Route                                      | Purpose                                                              |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `GET /api/v1/chat/session`                 | The session identifier this user may connect to, derived server-side |
| `ALL /api/v1/chat/:sessionId`              | WebSocket upgrade into the caller's own chat session                 |
| `GET /api/v1/chat/:sessionId/get-messages` | The session's stored transcript, served by the agent itself          |

Both are under `/api/`, so they are gated by exactly the same Access policy as every other API
route: the WebSocket upgrade needs no policy of its own.

### What the user sees

- The button is a toggle with `aria-expanded` and `aria-controls` pointing at the panel. `Esc`
  closes it and focus returns to the button.
- The panel is a Vuetify drawer: `temporary` below the `md` breakpoint so it overlays on a phone,
  `permanent` above it so the record under discussion stays beside the conversation.
- The transcript shows user messages, assistant Markdown (through the existing `MarkdownView`
  pipeline, so sanitisation is already solved), tool activity as a compact line — "Read a company" —
  and an approval card for a pending write. Records the assistant names are links into the app.
- Reopening the panel or reloading the page rejoins the same conversation: the transcript lives in
  the Durable Object, not in the tab.

### How it is grounded

By **tool calls over the live RPC contract**, not by a vector index. The system prompt carries the
caller's name, roles, and capabilities, the installation's formats, the fixed pipeline stage names,
the behavioural rules, and — when the panel sends one — a hint naming the record on screen. It
carries **no customer data**: a prompt that did would be a second copy of the CRM with no permission
model, which is exactly the escalation the design forbids. A unit test asserts that directly.

Capabilities are re-read from the Data Worker every turn rather than cached, so an owner removing a
role takes effect on the user's next message.

### Writes always ask

Every mutating tool is declared `needsApproval`, without exception. The stream pauses, the panel
shows what will happen with the arguments the assistant proposed, and nothing reaches the Data
Worker until the user approves. Declining is reported to the model as a declined action rather than
a failure, so the assistant says it was declined.

The idempotency key is **derived** from the chat request and the tool call, never supplied by the
model, so an approval replayed after a reconnect is a replay rather than a second record. Updates
still carry the version they were read at, so a concurrent change is a conflict rather than a silent
overwrite. Approval is user consent, not a permission grant: the Data Worker remains the authority
for permissions, validation, concurrency, audit, and idempotency, and a test calls a tool the caller
lacks and asserts `FORBIDDEN` rather than success.

### Sessions and lifetime

One session per user. The Durable Object instance is named `${userId}:${sessionId}`, where
`sessionId` is **derived server-side** from the verified identity: the browser asks
`GET /api/v1/chat/session` for its own session name, and the Worker re-derives and re-checks it on
every request. A name belonging to somebody else is refused with `403` before any dispatch, and a
name belonging to nobody gets the same answer, so a probe learns nothing.

The transcript is not business data. It never enters D1, and three hours after the last message the
object destroys it — genuinely gone, not archived. The authoritative record of what changed is the
audit trail, which names the actor, the change, and the channel (`chat`), and outlives the
conversation that produced it. A returning user whose session expired sees one line saying so.

### Model and cost control

Workers AI's `@cf/zai-org/glm-4.7-flash`, bound as `AI_CHAT_MODEL` so changing it is a configuration
edit, routed through a Terraform-owned AI Gateway with logging, a **30 requests / 60 seconds sliding
rate limit**, and a **$2 / 24 hours sliding spend cap**. Caching is off: replaying a cached
tool-calling round would repeat stale prose or skip a write. A turn is bounded to eight tool rounds,
the stored transcript to 100 messages, and what is sent to the model by `pruneMessages`. No prompt
or response content reaches the Worker's logs — the gateway holds the content, Workers Logs holds
the metadata.

A Gateway limit gives the panel a safe temporary-usage-limit message. It does **not** auto-retry the
failed turn or an approval continuation: retrying could replay a write, so recovery is always a
fresh, explicit user action after the limit window resets. The live-only rate-limit check is in
[`MCP-VALIDATION.md`](./MCP-VALIDATION.md).

Local development and the Playwright journeys use a **scripted model**
(`src/application-worker/chat/development-model.ts`) instead, gated on `import.meta.env.DEV`, which
every build compiles to a literal `false`. Without it `pnpm start` and `pnpm test:e2e` would call
the real service: they would not work offline, would spend the account's allowance, and would assert
different prose every run.

### Bundle cost: none unless opened

The panel, the Agents client, the AI SDK's chat pieces, and the Markdown renderer are all in a
lazily loaded chunk (about 77 kB gzipped), so a user who never opens chat downloads none of it.
`pnpm check` runs `check:bundles`, which fails if the SPA entry chunk exceeds its budget, the chat
transport appears in it at all, the `ChatPanel` lazy chunk disappears, or that chunk exceeds its 100
kB gzip budget. `pnpm report:bundles` writes the ignored JSON artifact for a release.

## MCP agent surface

`POST /mcp` exposes the catalogue's read and write CRM tools through a stateless Streamable HTTP MCP
server. Every write requires an idempotency key and, for updates, the version returned by a prior
read; the Data Worker performs the final permission, validation, concurrency, audit, and idempotency
checks. The MCP transport does not silently broaden authority: the authenticated actor is never a
tool argument, and a replay with the same key returns the original mutation result.

The endpoint is routed through the same Cloudflare Access policy and Worker-side JWT audience
validation as `/api`; Cloudflare Access Managed OAuth is configured on that existing application, so
the demo implements no separate OAuth Worker or token store. The tool server derives its actor only
from the verified identity and calls the existing `DATA_SERVICE` RPC client with `channel: 'mcp'`.

The endpoint is intentionally exact: `GET /mcp` returns `405 Allow: POST`, and only `/mcp` (not an
unreviewed future `/mcp/*` path) bypasses same-origin browser CSRF checks. Non-browser clients use
an explicit OAuth credential, not an ambient browser cookie. Tool visibility is capability-filtered
for usability; the Data Worker remains authoritative for authorization.

Managed OAuth is the one part that cannot be proven offline. The operator runbook,
[`MCP-VALIDATION.md`](./MCP-VALIDATION.md), covers a real client's Dynamic Client Registration and
login, one read and one disposable write with idempotency replay, the `mcp` audit channel, silent
refresh after the 15-minute Access token lifetime, and refusal after suspension.

## Phase 7: hardening

- **Coverage.** Every authored `src` runtime file is at ≥ 80% statements, branches, functions, and
  lines (not just the total). Gaps were closed through public interfaces, with no coverage
  exclusions; current `pnpm test` reports its exact totals (including the AI suites) instead of this
  historical pre-AI count.
- **Corner cases.** `tests/unit/edge-cases.test.ts`, `tests/client/drafts-and-boundaries.test.ts`,
  and `tests/unit/notes/notes-repository.test.ts` cover: deleted cursor rows and exactly-full last
  pages; Unicode names and UTF-16 length limits; two writers holding one version; idempotent replay
  after later edits; primary contacts moving company between read and commit; a failure at every
  statement of a write set leaving no partial rows; RPC error envelopes surviving structured
  cloning; one slow RPC timing out without affecting another; tombstoned note links; and the
  Markdown sanitiser on its own against hostile HTML.
- **Accessibility.** `tests/e2e/accessibility.spec.ts` runs axe-core (WCAG 2.0–2.2 A/AA) on the main
  pages in the light and dark themes at both sizes **and on the open assistant panel**. It also
  checks dialog focus return, 24 px targets, reflow at 320 CSS px, and reduced motion. Fixes include
  themed link colour, emphasis opacities raised to ≥ 4.5:1, focus return for every dialog and the
  chat panel, a shared polite announcer, `aria-expanded` drawer toggles, named task checkboxes, and
  a separate live-region wrapper that preserves the transcript's native list semantics.
- **Security.** Response security headers and a page CSP, an identity-header scrub, expired-session
  handling, guard-reason validation in the D1 error translator, generic messages for unexpected
  client errors, and pinned patched versions of two vulnerable dev-tool dependencies.
- **Performance and failure.** Median local API latency (`pnpm start`, seeded data, warm): 5–7 ms
  for lists, the dashboard, reports, search, and audit, and about 15 ms for the customer overview
  (two parallel RPC reads). Each use case issues a fixed number of bounded queries (no per-row
  loops), and `Intl` formatters are built once per configuration. Data Worker outages are exercised
  as safe, retryable 503s (`tests/unit/api/worker-entry.test.ts`, `tests/unit/api/app.test.ts`). The
  AI release adds Managed OAuth-protected MCP and a SQLite-backed Durable Object chat session; their
  Access-edge validation is documented in [`MCP-VALIDATION.md`](./MCP-VALIDATION.md). Vuetify
  remains the only component/CSS framework, and its registration is checked against the templates.

## Follow-on pass 1

Items from the first follow-on pass in
[`03-follow-ons.md`](../../specs/ignite-crm/03-follow-ons.md), one commit each.

- **Contact and company editing.** `PATCH /api/v1/contacts/:id` (new) and the existing
  `PATCH /api/v1/companies/:id` back **Edit contact** and **Edit company** dialogs for `crm.write`
  users; the Data Worker enforces the permission. Each save sends only the fields that changed
  (`src/client/services/crm-draft.ts`), with `If-Match` and an idempotency key. A validation error
  or a version conflict keeps the draft, and **Load latest version** lets the user save again
  without reverting fields someone else changed. A contact's company is edited by name, exactly as
  at creation: the same name (any case) is no change, another name reuses or creates that company,
  and a blank name detaches. The merged record must still have a name or a company. When a company's
  primary contact moves away, the same D1 batch clears that primary contact — unless someone already
  chose another one, which the conditional SQL keeps.

- **Your account.** The app-bar identity is now a menu with a role icon, the verified e-mail, **Your
  account**, and **Sign out** (the Access logout endpoint). `/account` shows the signed-in user's
  display name, e-mail, roles, and capabilities from the session. It is read-only by design: e-mail
  comes from Access and an owner manages display names and roles on the Team page. No profile
  mutation API or separate source of truth was introduced.

- **Shared-schema browser validation.** Contact, company, deal, activity, task, note, and team forms
  validate structured fields through the same Valibot request schemas that the Application and Data
  Workers enforce. Errors appear on blur, then update as the user corrects the field; submit reveals
  any remaining errors and does not send an invalid request. Browser validation is only a usability
  aid — neither Worker trusts it.

- **Phone numbers.** `src/shared/phone.ts` (on `libphonenumber-js` 1.13.15, the `/min` metadata
  entry point in both the SPA and the Data Worker) parses a newly entered number with the
  installation region (`GB`) as the default country. New writes must be valid and are stored in
  E.164 (`07523 185547` → `+447523185547`); invalid numbers and extensions are refused with a 422
  field error, and the browser shows the same message on blur and before submit. Pages show local
  numbers in national format and foreign ones internationally. **Existing values are not
  rewritten:** a pre-existing free-text phone is shown unchanged, and is only normalized when
  someone edits that field (the edit form sends phone only when it changed). No backfill migration
  is shipped, because D1 SQL cannot run the parser and release-one data is small; a reviewed,
  dry-run backfill (keeping the original text) is the path if older data needs converting. Upgrading
  the library is a data change: its number metadata decides validity. The metadata costs about 42 kB
  gzip in the Data Worker (65 → 108 kB) and lives in the lazily loaded contact chunks of the SPA
  (the entry chunk grew by under 2 kB gzip).

- **Deals stage filter.** The Deals table adds a **Stage** filter beside search and outcome, kept in
  the URL as `?view=list&stage=<id>`. `GET /api/v1/deals?stage=` passes `stageId` to the Data
  Worker, which refuses a stage outside the pipeline with a `stageId` field error rather than
  returning an empty page. Migration `0006_deal_stage_filter.sql` adds
  `deals_stage_list (stage_id, lower(title), id)`, so a filtered page follows the same keyset order.

- **Pipeline drill-down.** Every row label in the dashboard's Pipeline panel is a link, named for
  screen readers ("Show open deals in Qualified"), to the Deals table filtered to that row: a stage
  to its open deals, Won/Lost to that outcome, and the total to all open deals. A test follows each
  link and checks that the filtered list has as many rows as the panel counts.

- **"Pipeline total".** The dashboard panel's heading is now **Pipeline summary** and its open-deals
  row is **Pipeline total**, the usual sales term, so heading and row never read as a duplicate. The
  table takes its accessible name from the heading (`aria-labelledby`).

- **Pipeline this quarter.** Below Pipeline total, the dashboard shows **Pipeline Q4 2026** (for
  example): the count and value of open deals whose expected close date falls in the current
  calendar quarter. The quarter is part of `GET /api/v1/reports/pipeline` (`thisQuarter`) and
  follows that report's owner filter. Quarters are calendar quarters; there is no fiscal-year
  setting in this release.

- **Quarterly pipeline report.** Reports gains a **Quarterly pipeline** card
  (`QuarterlyPipelineCard.vue`, `GET /api/v1/reports/pipeline/quarterly?quarter=YYYY-Qn&ownerId=`).
  It shows open deals with an expected close date in one calendar quarter, by stage, plus a quarter
  total, and lists those deals by expected close date (at most 100; totals cover every match). The
  default quarter is the current one in the installation's time zone. The selector offers the
  previous, current, and next two quarters, plus any bookmarked quarter, and is kept in the URL. The
  card shares the Sales pipeline card's owner filter. Deals with no expected close date are not
  counted. Migration `0007_quarterly_pipeline.sql` adds a partial index over open, dated deals in
  listing order.

## Known limitations (first release)

- Notes cannot yet be deleted, task-list checkboxes are read-only (edit the Markdown to tick one),
  and note-to-note links are not part of release one. Standalone project creation, task deletion,
  and drag/drop are not part of release one; projects are created from won deals.
- Reports are on-screen only; CSV export (a "could have") is not in release one.
- List search for contacts, companies, and deals uses `LIKE '%term%'` within a page limit and has no
  per-user rate limiting. That is fine for a small team, but add FTS and rate limiting before wider
  exposure.
- Unfixed review items (mostly helper placement and typing polish) are listed in
  [`03-follow-ons.md`](../../specs/ignite-crm/03-follow-ons.md).
- The first-release contact action is one open ASAP or dated action per contact. More elaborate
  waiting/queued follow-ups and drag-and-drop ordering are not part of this review increment; the
  pipeline board uses a keyboard-first stage menu instead.
- SFC templates are not type-checked: there is no `vue-tsc` compatible with TypeScript 7 (the same
  constraint as the sibling demos). Script logic is covered by DOM tests.
