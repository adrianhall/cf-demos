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
| `pnpm start`    | `migrate:local` → `seed:local` → `cf dev --persist-to .cloudflare/state`                                                      |
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

| Project       | Runs in        | Covers                                                                                                                                    |
| ------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `unit`        | Node           | Schemas, domain, use cases over in-memory ports, Hono app over the fake                                                                   |
| `client`      | jsdom          | API client, views and components with a real `createVuetify()`                                                                            |
| `contract`    | Node           | Shared Data Worker contract suite against the in-memory fake                                                                              |
| `integration` | workerd (30 s) | Same contract suite against the real `DataEntrypoint` over RPC + D1, D1 port guards, full system journeys                                 |
| `e2e`         | Chromium       | Playwright: both Workers under `cf dev`, local D1, local Access login, desktop and mobile (90 s per test): journeys, axe WCAG 2.2 AA, CSP |

The fake Data Worker (`tests/fakes`) composes the **real** application services and SQL repositories
with an in-memory SQLite port, and passes the same contract suite as the real one. In the
integration project the Application Worker reaches `DataEntrypoint` through a genuine service
binding, so values cross a real RPC serialization boundary.

Istanbul measures every file under `src/**/*.{ts,vue}`; only tests and declaration files are
excluded. The report is written to `coverage/`.

The Playwright journeys (`tests/e2e`, `playwright.config.ts`) run offline. `scripts/e2e-server.ts`
recreates a dedicated `.cloudflare/e2e-state`, applies the data and local seed migrations, and
starts `cf dev` on port 5199. `vite.config.ts` selects that directory using `IGNITE_PERSIST_TO`, so
the dev server opens the same database the migrations wrote without touching your `pnpm start` data.
The journeys cover identity → contact/company → deal/activity → win and convert → task (moved with
the keyboard status menu) → multi-linked note and search → customer timeline → audit → reports, an
owner changing a teammate's role, and keyboard skip-link/navigation focus, each at 1440 × 900 and on
a Pixel 7. The browser is the Chromium build bundled with `@playwright/test`
(`pnpm exec playwright install chromium` once on a new machine).

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

Recorded with `pnpm check:bundles` (observational only — release one asserts no account limits). It
builds in a `bundles` mode that reads the committed placeholder outputs, so it runs in a clean
checkout; the emitted code is the same as a production build. The full per-file report is written to
the ignored `.cloudflare/bundle-report.json`.

| Artifact                    | Before Phase 6 | After Phase 6 | Release (Phase 7) | gzip (release) |
| --------------------------- | -------------: | ------------: | ----------------: | -------------: |
| SPA entry chunk             |       735.8 kB |      427.8 kB |          428.5 kB |       139.5 kB |
| SPA JavaScript (all chunks) |       735.8 kB |      768.3 kB |          772.6 kB |       265.8 kB |
| `markdown-renderer` chunk   |       (inline) |       74.9 kB |           75.0 kB |        24.7 kB |
| SPA CSS                     |       357.6 kB |      374.4 kB |          375.1 kB |        50.9 kB |
| Application Worker          |       294.4 kB |      305.6 kB |          307.8 kB |        78.2 kB |
| Data Worker                 |       276.1 kB |      287.1 kB |          287.3 kB |        65.5 kB |

The entry chunk is what every first visit downloads; Markdown and the other views now arrive only
when used. Total JavaScript grew slightly with Phase 6's own features; Phase 7's hardening
(announcer, focus management, security headers) added under 1% to any artifact.

## MCP deferral

The specification reserves `/mcp` for AI-assisted access (introduction §3.6), but release one ships
no MCP handler, OAuth Worker, or MCP tests. The path is deliberately absent from the Application
Worker's `runWorkerFirst` list, so it is not routed to Worker code. The Data Worker contract is the
seam a later MCP module would call, with the same RBAC.

## Phase 7: hardening

- **Coverage.** Every authored `src` runtime file is at ≥ 80% statements, branches, functions, and
  lines (not just the total). Gaps were closed through public interfaces, with no coverage
  exclusions; overall 97.4% statements, 91.0% branches, 95.6% functions, 97.4% lines over 542 Vitest
  tests, plus 20 Playwright checks.
- **Corner cases.** `tests/unit/edge-cases.test.ts`, `tests/client/drafts-and-boundaries.test.ts`,
  and `tests/unit/notes/notes-repository.test.ts` cover: deleted cursor rows and exactly-full last
  pages; Unicode names and UTF-16 length limits; two writers holding one version; idempotent replay
  after later edits; primary contacts moving company between read and commit; a failure at every
  statement of a write set leaving no partial rows; RPC error envelopes surviving structured
  cloning; one slow RPC timing out without affecting another; tombstoned note links; and the
  Markdown sanitiser on its own against hostile HTML.
- **Accessibility.** `tests/e2e/accessibility.spec.ts` runs axe-core (WCAG 2.0–2.2 A/AA) on 14 pages
  in the light and dark themes at both sizes. It also checks that dialogs return focus to their
  opener, 24 px targets, reflow at 320 CSS px, and reduced motion. Fixes include themed link colour,
  emphasis opacities raised to ≥ 4.5:1, focus return for every dialog, a shared polite announcer for
  moves and completions, focus that follows a moved card, `aria-pressed` toggles, `aria-expanded` on
  the drawer, marked required fields, named task checkboxes, valid list roles, and a 404 `h1`.
- **Security.** Response security headers and a page CSP, an identity-header scrub, expired-session
  handling, guard-reason validation in the D1 error translator, generic messages for unexpected
  client errors, and pinned patched versions of two vulnerable dev-tool dependencies.
- **Performance and failure.** Median local API latency (`pnpm start`, seeded data, warm): 5–7 ms
  for lists, the dashboard, reports, search, and audit, and about 15 ms for the customer overview
  (two parallel RPC reads). Each use case issues a fixed number of bounded queries (no per-row
  loops), and `Intl` formatters are built once per configuration. Data Worker outages are exercised
  as safe, retryable 503s (`tests/unit/api/worker-entry.test.ts`, `tests/unit/api/app.test.ts`). No
  MCP, OAuth, Durable Object, R2, or Queue dependency exists; Vuetify is the only component or CSS
  framework, and its registration is checked against the templates.

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
- Contact/company editing and the personal profile/menu are recorded in
  `specs/ignite-crm/03-follow-ons.md`; this phase adds project/task editing alongside deal editing.
  The broader live client-side validation and phone-number normalization remain follow-ons.
- The first-release contact action is one open ASAP or dated action per contact. More elaborate
  waiting/queued follow-ups and drag-and-drop ordering are not part of this review increment; the
  pipeline board uses a keyboard-first stage menu instead.
- SFC templates are not type-checked: there is no `vue-tsc` compatible with TypeScript 7 (the same
  constraint as the sibling demos). Script logic is covered by DOM tests.
