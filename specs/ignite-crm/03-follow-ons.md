# Ignite CRM — Decisions, assumptions, and follow-ons

This file records decisions made during implementation of
[`02-implementation.md`](./02-implementation.md) that the specification left open, plus follow-on
items to review at the end. Each entry names the phase that made it.

## Decisions confirmed by the product owner before Phase 1

1. **Bootstrap owner.** The repository-root `.env` `ADMIN_EMAIL` is bound into the Data Worker. On
   the first `resolveActor()` for that email, a conditional insert creates it as an active owner.
   After that, it has no special authorization behaviour.
2. **Unknown identities.** An Access-authenticated identity that has never been invited is
   auto-provisioned as an active user with the `read-only` role on first sign-in (not denied).
3. **Edge Access policy.** Cloudflare Access admits anyone who can authenticate against the team's
   identity providers; application RBAC decides what they may do. Inviting a teammate requires no
   Terraform change.
4. **Review data.** Migrations seed roles and permissions only. A separate local-only seed (run by
   `pnpm start` after `migrate:local`) creates one development identity per role and a few sample
   records. No sample data reaches the deployed D1 database.
5. **Git.** One conventional commit per phase on `cf/ignite-crm`; no push and no merge request.

## Assumptions made during implementation

- **Phase 1 — CRM visibility.** The fixed role matrix grants `crm.read` to every seeded role, and
  private contacts are only a Could-have story. Phase 1 therefore has installation-wide read
  visibility for active companies/contacts; write actions require `crm.write`. Per-record privacy
  remains a later, explicit product decision.
- **Phase 1 — RPC errors.** Expected Data Worker failures travel as serializable
  `{ ok: false, error }` values rather than thrown RPC errors. This avoids uncaught-exception logs
  for ordinary 403/404/409 outcomes and keeps transport outages distinct from answered errors.
- **Phase 1 — D1 transactions.** D1's atomic `batch()` has no interactive transaction. The port
  builds a write set from reads, then commits it as one batch; SQL guards inside that batch abort on
  lost compare-and-swap preconditions. This is the release-one atomicity strategy; it is tested
  against real D1.
- **Phase 1 — local seed.** `cf d1 query` has no local mode, so the local-only sample data is a
  separate migration stream (`migrations/seed/9001_local_seed.sql`) applied by the repository's
  migration helper with `--local`. It is never applied remotely. The health report excludes it from
  the schema migration version.
- **Phase 1 — TypeScript SFC checking.** TypeScript 7 is pinned by the sibling demos and no
  compatible `vue-tsc` is installed. `tsc` checks all `.ts` script modules (including both Workers)
  and DOM tests exercise the Vue SFCs; template expressions are not statically checked yet.
- **Phase 1 — Companies House link.** Only official
  `https://find-and-update.company-information.service.gov.uk/company/…` URLs are accepted, rather
  than arbitrary external URLs, because this field represents an official company registration.
- **Phase 1 — contact-create concurrency.** The case-insensitive unique company-name index makes two
  concurrent first-contact creates for the same new company race safely: one succeeds; the other
  receives 409 and can retry with the now-existing company. There is no automatic retry inside a
  write transaction.
- **Phase 1 — date formatting.** The installation date-format vocabulary is `short|medium|long`
  (Intl `dateStyle`) and the UK default is `medium`. No user-specific overrides in release one.
- **Phase 1 — UI theme.** The Vuetify light and dark themes use Cloudflare orange `#FC7C1E` as
  primary and `#5A73F4` as secondary, both with dark `on-*` text, because white text falls below AA.
  Where a brand colour becomes text (tonal cards, active navigation, focused fields), the themes
  supply AA-compliant `primary-strong`/`secondary-strong` tones: darker shades in light mode and
  lighter tints in dark mode. The browser follows the system preference.
- **Phase 1 — local development.** Local sample data uses `.example` e-mails and fictional
  companies/addresses. `ADMIN_EMAIL` in production is the root `.env` value, not a committed
  identity; the committed local placeholder is `owner@example.com`.

- **Phase 2 — fixed pipeline.** One migration-seeded sales pipeline has Lead, Qualified, Proposal,
  and Negotiation stages. Stage editing remains outside release-one UI. Won/lost deals retain their
  last stage for history; closing stamps `closedAt` and clears their next action.
- **Phase 2 — ownership and visibility.** Sales records are installation-wide for `crm.read` users;
  ownership determines the actor's action stream, not row-level secrecy. `crm.assign` is granted
  only to owner/manager and is required for any explicit owner assignment on a deal. A contact's one
  open next action is assigned to the user who sets it, including on replacement.
- **Phase 2 — next-action model.** One open action per contact (rather than many queued follow-ups)
  drives the first-release worklist; its due date is optional (`null` means ASAP). There is no
  waiting/queued state or manual ordering in this release. Open actions are replaced using an
  expected version and completed actions remain in history. Newly entered due dates may not be in
  the past; existing actions naturally become overdue. The action stream is capped at 100 rows,
  sorted ASAP, by date, contact before deal on a tie, then by id. "Today" is the installation's
  `Europe/London` calendar date, not the browser's or UTC's.
- **Phase 2 — activity validation.** A call/meeting needs at least one and at most 20 distinct,
  active contacts. External participants need not work for the linked company. A company and deal on
  the same activity must agree when the deal has a company. At most five minutes of future clock
  skew is accepted; the activity is history, not a scheduled event. Customer timelines cap deals and
  activities at 50 rows each and retain deleted contacts as tombstones in past activities.
- **Phase 2 — currency and idempotency.** Amounts are non-negative integer minor units in the
  installation currency (GBP), capped at £10 billion to stay in JavaScript's exact-integer range.
  The SPA reuses an idempotency key only for an unchanged retry whose outcome is unknown (network
  failure or 503); corrected validation failures and conflicts begin a new intent.
- **Phase 2 — in-memory test port.** The fake Data Worker now composes the production services and
  SQL repositories over Node's in-memory SQLite. It runs committed migrations and mirrors D1's
  atomic batch/guard semantics. This replaces the hand-maintained in-memory business model and lets
  contract tests run against both SQLite and real Workers RPC+D1.

- **Phase 3 — conversion.** The shared D1 database makes conversion one atomic batch: a won,
  unconverted deal becomes one project, conversion record, versioned deal back-link, audit events,
  and idempotency result, or none of them. There is no pending/saga state or recovery endpoint. A
  converted deal must remain won; reopening it would invalidate its delivery source. A retry with
  the same idempotency key returns the original result, while a fresh conversion request is a 409.
  Project name defaults to the deal title, and lead defaults to the converting user; the company and
  contact come only from the deal. The linked project's customer context is a conversion-time
  snapshot and is not silently changed by later deal edits.
- **Phase 3 — project/task scope.** Projects are created from won deals only in this increment;
  standalone creation is a later story. Projects have `active|on_hold|completed|archived` states;
  only managers/owners (`project.manage`) may archive, unarchive, or change the lead. Archived
  projects stay visible but accept no task changes. Delivery users may create, edit, assign, and
  progress tasks (`project.write`); sales users may convert but not manage tasks. A task has the
  fixed `todo|in_progress|in_review|done` workflow and `no_priority|low|medium|high|urgent`
  priority, with a sparse position per column. Changing status appends to the target column, stamps
  `completedAt` on done and clears it on reopening. There is no drag/drop: the keyboard-operable
  status menu is the primary control.
- **Phase 3 — personal work.** My Work shows up to 100 open tasks assigned to the actor in
  non-archived projects, dated tasks first (overdue, then future), higher priority on the same date,
  undated tasks last. Newly entered due and target dates cannot be in the past; existing dates
  naturally become overdue. Project detail caps its board at 200 tasks and customer timelines at 50
  projects per customer. Task creation, editing, and project status edits use idempotency keys and
  versioned updates; a version conflict keeps the user's draft.

- **Phase 3 — Mark won/lost (review feedback).** Stage and outcome stay separate fields, but closing
  a deal is now an explicit **Mark won/lost** dialog rather than a field hidden in the deal editor.
  "Won" with the (default-checked) conversion option is a single atomic Data Worker transaction
  (`convertDeal` with `markWon`), so a failed conversion never leaves a won-but- unconverted deal;
  the deal is closed exactly as a manual win would (close time stamped, next action and expected
  close date cleared). The option is disabled for "Lost" and for roles without `deal.convert`; a
  lost deal cannot be won-and-converted in one step (reopen it first).

- **Phase 4 — link visibility.** Release one has installation-wide visibility per permission, so
  "the actor can see the target" means the target exists, is not deleted, and the actor holds the
  read permission for its type (`crm.read` for contacts, companies, and deals; `project.read` for
  projects). Linking a type the actor cannot read is `FORBIDDEN`; an absent or deleted target is
  `VALIDATION_FAILED` naming `links.<index>`. Only _newly added_ targets are validated on update:
  kept links stay even if their record was deleted since (links are history).
- **Phase 4 — link limits and duplicates.** A note has 1–20 links. Duplicates are refused with the
  duplicate's index rather than merged, because a client sending one record twice has a bug. Links
  are stored and hashed in canonical (type, id) order, so the order a user picks records in does not
  change the idempotency hash; they are displayed by type, then label.
- **Phase 4 — edit rule.** Authors edit their own notes; editing another's needs `note.manage` (01d
  §6, open question 4 kept as decided). There is no note deletion in this increment; the schema has
  `deleted_at`, and deleted notes are excluded from reads, feeds, and the FTS index.
- **Phase 4 — task-list checkboxes are read-only.** 01d open question 5 proposed interactive
  checkboxes as an optimistic note update. They render disabled in this increment so the rendered
  view never mutates; ticking one is an edit of the Markdown. Interactive ticking can be added later
  as an ordinary versioned `updateNote`.
- **Phase 4 — search transport and syntax.** Search is `POST /notes/search` with a JSON body so the
  text stays out of URLs, history, `Referer`, and logs; the SPA likewise does not reflect it in the
  address bar (unlike the other list pages). Text is tokenized into at most 8 quoted prefix terms,
  ANDed; there is no phrase, OR, or exclusion syntax. Diacritics fold
  (`unicode61 remove_diacritics 2`). Title matches weigh 5× body matches in BM25.
- **Phase 4 — Markdown subset.** HTML is disabled (shown as text, not stripped); images render as
  alt text so a shared note never fetches remote content; links are limited to `http:`, `https:`,
  `mailto:`, and relative URLs. Headings shift down two levels so a note never adds an `h1`/`h2`.
  `marked` and `dompurify` were added (exact pins, already used by `cf-terraform-demos/playground`).
- **Phase 4 — request size.** Note create/update accept up to 512 KiB of JSON because escaping can
  grow 64 KiB of Markdown (up to 6× for control bytes); the Data Worker enforces the real 64 KiB
  UTF-8 limit, and the D1 schema checks it again.
- **Phase 4 — context feeds.** Each record page's Notes card loads independently and pages with
  "Show more notes" (25 at a time). A feed failure is shown inside the card; the record stays
  usable. Notes are not added to the contact/company/deal/project RPC projections, so those
  projections' query budgets are unchanged.

- **Phase 5 — `users.read`.** A new permission lets managers read the team directory and role
  catalogue (needed to reassign coverage and to filter the audit trail by person) without being able
  to change membership. 01a open question 1 is kept as decided: only owners invite, change roles, or
  change status.
- **Phase 5 — invitation keeps auto-provisioning.** An invitation pre-creates an active user with
  the chosen roles; there is no separate `invited` state, because confirmed decision 2 still
  auto-provisions any un-invited Access identity as read-only. An invite therefore means "this
  person's first sign-in has these roles". Inviting an e-mail already on the team is `CONFLICT` with
  `fields.email` (rather than 01a's idempotent success for a pending invite, which has no equivalent
  state here). The owner enters the display name (01a open question 4).
- **Phase 5 — status vocabulary.** Owners can suspend and reactivate. Deletion is not offered: user
  ids are referenced from every record and the audit trail, so a suspended account is the
  release-one way to remove access. An owner cannot suspend themselves.
- **Phase 5 — final owner.** Enforced by a commit-time guard counting active owners after the
  change, in the same batch; the service's earlier read only produces the friendly message.
- **Phase 5 — role transport.** Role and status changes are `PUT /users/:id/roles|status` (they
  replace a whole value) with `If-Match`; 01e's `PATCH` naming was adjusted to match semantics.
- **Phase 5 — audit is one table, not a merged cursor.** 01e §Audit described merging per-service
  cursors; with one D1 database the trail is a single keyset query. Metadata passes an allowlist on
  the way out, and redacted events are flagged rather than hidden.
- **Phase 5 — capability hints.** Hints load once per page load and are refreshed immediately when
  an owner edits their own roles. Another user's hints refresh on their next page load; the server
  enforces the change on their very next request regardless.

- **Phase 6 — reports are open to `report.read`.** The plan said "owner/manager authorization" for
  reports, but the seeded matrix (01a §3.2, confirmed in Phase 1) grants `report.read` to every
  role, and the dashboard already showed the pipeline summary to everyone. The Reports page follows
  the matrix; narrowing it would be a seeded-role change, not a report change.
- **Phase 6 — report filters.** Pipeline: owner and an inclusive close-date window (≤ 366 days, in
  the installation time zone, applied to won/lost only). Delivery: project state (active, on hold,
  completed; archived excluded) and lead. The delivery report lists at most 50 projects by most open
  work; totals cover all. `/reports/pipeline` keeps its path and with no query returns the summary
  the dashboard uses (a superset of the old shape).
- **Phase 6 — overview assembled in the Application Worker.** `GET /contacts|companies/:id/overview`
  makes two parallel RPC reads (core detail, first notes page). Only notes is optional; a retryable
  notes failure returns `notes: null` plus a warning, any `FORBIDDEN` or core failure fails the
  request. Projects are part of the core detail read, so they are not separately optional. The older
  `GET /contacts/:id` and `/companies/:id` detail routes remain for other callers.
- **Phase 6 — lazy routes as well as lazy Markdown.** Splitting only `marked`/`dompurify` reduced
  the entry chunk to 662.6 kB, still over Vite's 500 kB warning. Every view except the dashboard is
  therefore also a route-level chunk (entry chunk 427.8 kB). The warning limit was not raised.
- **Phase 6 — E2E harness.** Playwright 1.63.0 (pinned to the locally cached Chromium build) runs
  against `cf dev` with a dedicated `.cloudflare/e2e-state`, signing in through the toolkit's local
  Access login form. `pnpm test` runs Vitest (with the coverage gate) then Playwright.
- **Phase 6 — bundle report mode.** `check:bundles` builds in a `bundles` mode with the committed
  placeholder outputs so it works without a deployment; it is observational and enforces nothing.
- **Phase 6 — deployment checkpoint.** `pnpm deploy` succeeded with an unchanged Terraform plan,
  then authenticated `cf` listed the two Workers and D1 database. The custom hostname redirected to
  Cloudflare Access; the in-app browser could not finish the IdP sign-in, so an authenticated
  deployed UI smoke test was not possible in that browser session. `pnpm teardown` succeeded: both
  Workers were deleted, Terraform destroyed three resources, authenticated `cf` listings showed no
  Ignite CRM Workers or D1 database, and `terraform state list` was empty.

- **Phase 7 — review scope and fixes.** The review-orchestrator reviewed the whole demo (report and
  per-finding status in [`04-mvp-review.md`](./04-mvp-review.md)). Findings were fixed only where a
  Phase 7 deliverable called for it: security review (D3), WCAG review (D4), and performance/failure
  review (D5). Refactor-only findings stay open and are listed below.
- **Phase 7 — real-browser accessibility gate.** `@axe-core/playwright` 4.13.0 scans 14 pages in
  light and dark themes at both E2E sizes as part of `pnpm test`, with target-size, 320 px reflow,
  reduced-motion, and dialog-focus checks. To meet 4.5:1, the theme raises Vuetify's emphasis
  opacities; a future theme change must keep that scan green.
- **Phase 7 — CSP allows inline styles.** Vuetify writes its theme as a runtime `<style>` element
  and sets inline style attributes, so `style-src` includes `'unsafe-inline'`; `script-src` is
  `'self'` only. `cf dev` does not apply `public/_headers`, so `tests/e2e/csp.spec.ts` injects the
  committed policy to prove compatibility. HSTS is left to the zone.
- **Phase 7 — repository-wide dependency pins.** `sharp: 0.35.5` and `shell-quote@<1.11.0: 1.12.0`
  were added to the root `pnpm-workspace.yaml` `overrides`, so other demos pick them up too. One
  peer-resolved `sharp@0.35.4` remains in the lockfile under an _optional_ webpack peer chain
  (vue-router → unplugin → webpack → minimizer-webpack-plugin) that Ignite CRM never installs or
  runs; two lockfile re-resolutions did not remove it. Remove the pins once upstream depends on the
  patched versions.
- **Phase 7 — expired Access session.** A redirected or HTML API response is treated as an expired
  sign-in, and the SPA offers **Sign in** (a full reload so Access can run its flow) instead of a
  retry.
- **Phase 7 — clean-state D1 persistence.** `cf dev`'s Vite delegate no longer forwards
  `--persist-to` (only mode/port/host/local). Migrations wrote `.cloudflare/e2e-state` but Vite
  opened `.cloudflare/state`, so clean E2E runs failed every sign-in with a retryable 503. The
  `cloudflare()` plugin now reads `persistState.path` from `IGNITE_PERSIST_TO` (default
  `.cloudflare/state`); `e2e-server.ts` sets that variable, and `start:dev` runs `cf dev` without a
  discarded flag. Verified with clean `.cloudflare/state` and `.cloudflare/e2e-state`: local owner
  sign-in, both E2E sizes, and full `pnpm test` pass.
- **Phase 7 — lifecycle rehearsal.** From a clean local state, `pnpm check` and `pnpm test` passed,
  `pnpm start` served the seeded CRM, and desktop/mobile layouts were inspected. Terraform's
  pre-deploy plan showed no changes. `pnpm deploy` succeeded; the hostname redirected to Access, but
  the browser panel could not complete the corporate IdP sign-in, so an authenticated deployed UI
  smoke test was not possible there. `pnpm teardown` succeeded, deleting both Workers and destroying
  three Terraform resources. Authenticated `cf` showed no Ignite CRM Workers or D1, and
  `terraform state list` was empty. The final deploy follows the Phase 7 commit and stays up.

## Follow-on items

- **CRM record editing — not scheduled in Phases 2–7.** Add contact editing and company editing to
  the SPA, with the corresponding contact update service/API contract (company update exists in the
  Data Worker and API but has no UI). Preserve drafts on validation and version conflicts, and
  enforce `crm.write` in the Data Worker. Phase 2 schedules a _deal_ editor and expanded
  contact/company detail projections, not contact/company editors; Phase 6's general UI refinement
  does not explicitly cover these forms.
- **Signed-in user menu and details — not scheduled in Phases 2–7.** Give the top-right identity a
  deliberate treatment (for example, role icon/chip and a menu linking to the signed-in user's
  details). The Phase 5 team directory and role-assignment UI do not explicitly provide a personal
  details page or an account menu. Decide which profile fields, if any, a user can edit before
  adding that page.
- **Client-side field validation — not scheduled in Phases 2–7.** Validate structured fields in the
  SPA while the user types, as well as before submission, for usability and defence in depth. For
  example, the create-contact form currently sends `ahall@cloudflarecom` and shows the error only
  after the server's 422. Reuse the shared Valibot schemas (or rules derived from them) so the
  browser and server cannot disagree; the Application Worker and Data Worker must keep validating,
  because client checks can be bypassed. Show errors accessibly without nagging before the user has
  finished a field (for example, validate on blur, then live once a field is invalid), and block
  submission while known errors remain.
- **Phone-number validation and normalization — not scheduled in Phases 2–7.** Phone is currently
  free text (trimmed, at most 40 characters). Validate phone numbers while the user types and on
  submit, and normalize them to E.164 for storage/search (for example, `07523 185547` with the
  installation's `GB` region becomes `+447523185547`), displaying them in a readable national or
  international format. This needs a deliberate dependency choice (such as `libphonenumber-js`)
  shared by client and server, a decision on rejecting versus accepting-and-flagging numbers that
  cannot be parsed, and a migration or backfill plan for existing free-text values.
- **Deals list stage filter — not scheduled in Phases 2–7.** The Deals page's list (table) view
  filters by search text and outcome (`pending|won|lost`) only. Add a **Stage** filter alongside
  them, populated from the pipeline's fixed stages, combinable with search and outcome, and kept in
  the URL (`?view=list&stage=<id>`) like the existing filters. It needs a `stageId` option on the
  deals list contract (`DealListOptions`, the `GET /api/v1/deals` query schema, and the repository
  query), validated against the pipeline's stages in the Data Worker, with an indexed query that
  keeps the keyset paging order.
- **Drill-down from the dashboard pipeline panel — not scheduled in Phases 2–7.** Each row of the
  dashboard's Pipeline panel should link to the Deals page's table view filtered to that row: a
  stage row to open (`pending`) deals in that stage (`/deals?view=list&status=pending&stage=<id>`),
  the Won and Lost rows to that outcome (`?view=list&status=won|lost`), and the total row to all
  open deals (`?view=list&status=pending`). Depends on the stage filter above. Make each row label a
  real link (keyboard-reachable, with an accessible name such as "Show deals in Qualified"), and
  test that the filtered list's counts agree with the panel.
- **Rename "Open total" to "Pipeline total" — not scheduled in Phases 2–7.** In the dashboard's
  Pipeline panel, relabel the open-deals total row from "Open total" to "Pipeline total", the usual
  sales term for the value of open opportunities. Because the panel heading is also "Pipeline",
  review the heading at the same time (for example "Pipeline summary") so the row label and heading
  do not read as a duplicate to screen-reader users; update the DOM tests that assert the label.
- **Add "Pipeline this qtr" line to the dashboard's Pipeline panel** (below the pipeline total) -
  this will provide the total pipeline for deals that are expected to close this quarter.
- **Add a "Quarterly Pipeline" report to the report set**, covering this quarters pipeline deals and
  where they are in the pipeline (stage).

- **Phase 1 — check script writes ignored artifacts.** The implementation plan requires generated
  type freshness for both Workers and dry Vite builds inside `pnpm check`; `cf workers types` and
  Vite currently write ignored `.cloudflare/` artifacts to do this. This conflicts with the
  repository-wide rule that `check` must never write files. The chosen implementation follows the
  more specific Ignite plan and sibling demo convention while never modifying tracked sources.
  Revisit when `cf workers types` and the Vite plugin offer read-only freshness/dry-build modes.
- **Phase 1 — Vue SFC typechecking.** Revisit `vue-tsc` once a version compatible with the
  workspace's TypeScript 7 is available; until then DOM tests and Vite builds catch template errors.
- **Phase 1 — RFC 9457 consistency.** The Data Worker has no public HTTP surface; if a future
  transport is added, preserve the envelope/error mapping and re-run the shared contract suite.
- **Phase 1 — local seed bookkeeping.** The local-only seed shares `d1_migrations` with the data
  stream. If a later migration helper supports a separate local seed ledger, migrate the seed out of
  `d1_migrations`; the health query already excludes it.
- **Phase 1 — deferred UI.** Deals/activities, projects/tasks, notes, team administration, audit
  viewer, and reports are in Phases 2–6. No active MCP handler is introduced in release one.

### From the Phase 7 review (unfixed; see `04-mvp-review.md`)

- **ARCH-001 / ARCH-002 — shared helper placement.** Move the cursor codec and `ListCriteria` to
  `data-worker/application/shared/paging.ts`, and `mutationMeta`/`expectedVersion`/`pathId` to one
  `application-worker/api/preconditions.ts`.
- **ARCH-003 — generated Data Worker types.** Derive `DataBindings` from `dataWorkerEnv()`, or
  include the Data Worker's generated types in a tsconfig.
- **ARCH-004 — cross-module table reads (accepted for MVP).** The CRM timeline reads sales and
  projects tables through their repository ports; record this in spec §3.1 as the coupling to undo
  if a module is ever split out.
- **CODE-004** — report bad `Idempotency-Key`/`If-Match` headers as header problems, not query
  problems. **CODE-005** — validate replayed idempotent results against the response schema instead
  of relying on the API tier's `checkResponse`. **CODE-007/008** — fix ContactPicker's duplicated
  JSDoc and clear its debounce on unmount. **CODE-009** — a clearer error for RPC contract drift in
  the data-client proxy. **CODE-010** — explicit `Promise<T>` return types on `ApiClient` methods.
  **CODE-011** — exhaustive `switch` in `link-search.ts`.
- **SEC-004 (accepted)** — the Access policy admits any authenticated identity (provisioned
  read-only). Restrict it to a domain or Access group for a real deployment.
- **SEC-006 (deferred)** — per-user rate limiting, and FTS/prefix search for contact, company, and
  deal lists, before exposing the app beyond a small team.
- **A11Y-006 (partly fixed)** — merge ContactPicker's search field and autocomplete into one
  server-searching `VAutocomplete`, keeping an explicit keyboard Add path.
- **A11Y-010 (partly fixed)** — confirm before archiving a project from the status select.
- **Tooling** — run full Semgrep registry packs and CodeQL in CI; the review could only run targeted
  Semgrep rules and skipped CodeQL.
