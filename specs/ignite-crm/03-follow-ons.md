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
  migration helper with `--local`. It is never applied remotely. The health report excludes it
  from the schema migration version.
- **Phase 1 — TypeScript SFC checking.** TypeScript 7 is pinned by the sibling demos and no
  compatible `vue-tsc` is installed. `tsc` checks all `.ts` script modules (including both Workers)
  and DOM tests exercise the Vue SFCs; template expressions are not statically checked yet.
- **Phase 1 — Companies House link.** Only official `https://find-and-update.company-information.service.gov.uk/company/…`
  URLs are accepted, rather than arbitrary external URLs, because this field represents an
  official company registration.
- **Phase 1 — contact-create concurrency.** The case-insensitive unique company-name index makes
  two concurrent first-contact creates for the same new company race safely: one succeeds; the
  other receives 409 and can retry with the now-existing company. There is no automatic retry
  inside a write transaction.
- **Phase 1 — date formatting.** The installation date-format vocabulary is `short|medium|long`
  (Intl `dateStyle`) and the UK default is `medium`. No user-specific overrides in release one.
- **Phase 1 — UI theme.** The Vuetify light and dark themes use Cloudflare orange `#FC7C1E`
  as primary and `#5A73F4` as secondary, both with dark `on-*` text, because white text falls
  below AA. Where a brand colour becomes text (tonal cards, active navigation, focused fields), the
  themes supply AA-compliant `primary-strong`/`secondary-strong` tones: darker shades in light
  mode and lighter tints in dark mode. The browser follows the system preference.
- **Phase 1 — local development.** Local sample data uses `.example` e-mails and fictional
  companies/addresses. `ADMIN_EMAIL` in production is the root `.env` value, not a committed
  identity; the committed local placeholder is `owner@example.com`.

- **Phase 2 — fixed pipeline.** One migration-seeded sales pipeline has Lead, Qualified, Proposal,
  and Negotiation stages. Stage editing remains outside release-one UI. Won/lost deals retain their
  last stage for history; closing stamps `closedAt` and clears their next action.
- **Phase 2 — ownership and visibility.** Sales records are installation-wide for `crm.read` users;
  ownership determines the actor's action stream, not row-level secrecy. `crm.assign` is granted
  only to owner/manager and is required for any explicit owner assignment on a deal. A contact's
  one open next action is assigned to the user who sets it, including on replacement.
- **Phase 2 — next-action model.** One open action per contact (rather than many queued follow-ups)
  drives the first-release worklist; its due date is optional (`null` means ASAP). There is no
  waiting/queued state or manual ordering in this release. Open actions are replaced using an
  expected version and completed actions remain in history. Newly entered due dates may not be in
  the past; existing actions naturally become overdue. The action stream is capped at 100 rows,
  sorted ASAP, by date, contact before deal on a tie, then by id. "Today" is the installation's
  `Europe/London` calendar date, not the browser's or UTC's.
- **Phase 2 — activity validation.** A call/meeting needs at least one and at most 20 distinct,
  active contacts. External participants need not work for the linked company. A company and deal
  on the same activity must agree when the deal has a company. At most five minutes of future clock
  skew is accepted; the activity is history, not a scheduled event. Customer timelines cap deals
  and activities at 50 rows each and retain deleted contacts as tombstones in past activities.
- **Phase 2 — currency and idempotency.** Amounts are non-negative integer minor units in the
  installation currency (GBP), capped at £10 billion to stay in JavaScript's exact-integer range.
  The SPA reuses an idempotency key only for an unchanged retry whose outcome is unknown (network
  failure or 503); corrected validation failures and conflicts begin a new intent.
- **Phase 2 — in-memory test port.** The fake Data Worker now composes the production services and
  SQL repositories over Node's in-memory SQLite. It runs committed migrations and mirrors D1's
  atomic batch/guard semantics. This replaces the hand-maintained in-memory business model and
  lets contract tests run against both SQLite and real Workers RPC+D1.

- **Phase 3 — conversion.** The shared D1 database makes conversion one atomic batch: a won,
  unconverted deal becomes one project, conversion record, versioned deal back-link, audit events,
  and idempotency result, or none of them. There is no pending/saga state or recovery endpoint.
  A converted deal must remain won; reopening it would invalidate its delivery source. A retry with
  the same idempotency key returns the original result, while a fresh conversion request is a 409.
  Project name defaults to the deal title, and lead defaults to the converting user; the company
  and contact come only from the deal. The linked project's customer context is a conversion-time
  snapshot and is not silently changed by later deal edits.
- **Phase 3 — project/task scope.** Projects are created from won deals only in this increment;
  standalone creation is a later story. Projects have `active|on_hold|completed|archived` states;
  only managers/owners (`project.manage`) may archive, unarchive, or change the lead. Archived
  projects stay visible but accept no task changes. Delivery users may create, edit, assign, and
  progress tasks (`project.write`); sales users may convert but not manage tasks. A task has the
  fixed `todo|in_progress|in_review|done` workflow and
  `no_priority|low|medium|high|urgent` priority, with a sparse position per column. Changing
  status appends to the target column, stamps `completedAt` on done and clears it on reopening.
  There is no drag/drop: the keyboard-operable status menu is the primary control.
- **Phase 3 — personal work.** My Work shows up to 100 open tasks assigned to the actor in
  non-archived projects, dated tasks first (overdue, then future), higher priority on the same
  date, undated tasks last. Newly entered due and target dates cannot be in the past; existing
  dates naturally become overdue. Project detail caps its board at 200 tasks and customer
  timelines at 50 projects per customer. Task creation, editing, and project status edits use
  idempotency keys and versioned updates; a version conflict keeps the user's draft.

- **Phase 3 — Mark won/lost (review feedback).** Stage and outcome stay separate fields, but
  closing a deal is now an explicit **Mark won/lost** dialog rather than a field hidden in the deal
  editor. "Won" with the (default-checked) conversion option is a single atomic Data Worker
  transaction (`convertDeal` with `markWon`), so a failed conversion never leaves a won-but-
  unconverted deal; the deal is closed exactly as a manual win would (close time stamped, next
  action and expected close date cleared). The option is disabled for "Lost" and for roles without
  `deal.convert`; a lost deal cannot be won-and-converted in one step (reopen it first).

- **Phase 4 — link visibility.** Release one has installation-wide visibility per permission, so
  "the actor can see the target" means the target exists, is not deleted, and the actor holds the
  read permission for its type (`crm.read` for contacts, companies, and deals; `project.read` for
  projects). Linking a type the actor cannot read is `FORBIDDEN`; an absent or deleted target is
  `VALIDATION_FAILED` naming `links.<index>`. Only *newly added* targets are validated on update:
  kept links stay even if their record was deleted since (links are history).
- **Phase 4 — link limits and duplicates.** A note has 1–20 links. Duplicates are refused with
  the duplicate's index rather than merged, because a client sending one record twice has a bug.
  Links are stored and hashed in canonical (type, id) order, so the order a user picks records in
  does not change the idempotency hash; they are displayed by type, then label.
- **Phase 4 — edit rule.** Authors edit their own notes; editing another's needs `note.manage`
  (01d §6, open question 4 kept as decided). There is no note deletion in this increment; the
  schema has `deleted_at`, and deleted notes are excluded from reads, feeds, and the FTS index.
- **Phase 4 — task-list checkboxes are read-only.** 01d open question 5 proposed interactive
  checkboxes as an optimistic note update. They render disabled in this increment so the rendered
  view never mutates; ticking one is an edit of the Markdown. Interactive ticking can be added later
  as an ordinary versioned `updateNote`.
- **Phase 4 — search transport and syntax.** Search is `POST /notes/search` with a JSON body so
  the text stays out of URLs, history, `Referer`, and logs; the SPA likewise does not reflect it in
  the address bar (unlike the other list pages). Text is tokenized into at most 8 quoted prefix
  terms, ANDed; there is no phrase, OR, or exclusion syntax. Diacritics fold
  (`unicode61 remove_diacritics 2`). Title matches weigh 5× body matches in BM25.
- **Phase 4 — Markdown subset.** HTML is disabled (shown as text, not stripped); images render as
  alt text so a shared note never fetches remote content; links are limited to `http:`, `https:`,
  `mailto:`, and relative URLs. Headings shift down two levels so a note never adds an `h1`/`h2`.
  `marked` and `dompurify` were added (exact pins, already used by `cf-terraform-demos/playground`).
- **Phase 4 — request size.** Note create/update accept up to 512 KiB of JSON because escaping can
  grow 64 KiB of Markdown (up to 6× for control bytes); the Data Worker enforces the real 64 KiB UTF-8 limit, and the D1 schema
  checks it again.
- **Phase 4 — context feeds.** Each record page's Notes card loads independently and pages with
  "Show more notes" (25 at a time). A feed failure is shown inside the card; the record stays
  usable. Notes are not added to the contact/company/deal/project RPC projections, so those
  projections' query budgets are unchanged.

## Follow-on items

- **CRM record editing — not scheduled in Phases 2–7.** Add contact editing and company editing
  to the SPA, with the corresponding contact update service/API contract (company update exists in
  the Data Worker and API but has no UI). Preserve drafts on validation and version conflicts, and
  enforce `crm.write` in the Data Worker. Phase 2 schedules a *deal* editor and expanded
  contact/company detail projections, not contact/company editors; Phase 6's general UI refinement
  does not explicitly cover these forms.
- **Signed-in user menu and details — not scheduled in Phases 2–7.** Give the top-right identity a
  deliberate treatment (for example, role icon/chip and a menu linking to the signed-in user's
  details). The Phase 5 team directory and role-assignment UI do not explicitly provide a personal
  details page or an account menu. Decide which profile fields, if any, a user can edit before
  adding that page.
- **Client-side field validation — not scheduled in Phases 2–7.** Validate structured fields in
  the SPA while the user types, as well as before submission, for usability and defence in depth.
  For example, the create-contact form currently sends `ahall@cloudflarecom` and shows the error
  only after the server's 422. Reuse the shared Valibot schemas (or rules derived from them) so the
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
  stream. If a later migration helper supports a separate local seed ledger, migrate the seed out
  of `d1_migrations`; the health query already excludes it.
- **Phase 1 — deferred UI.** Deals/activities, projects/tasks, notes, team administration, audit
  viewer, and reports are in Phases 2–6. No active MCP handler is introduced in release one.
