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
