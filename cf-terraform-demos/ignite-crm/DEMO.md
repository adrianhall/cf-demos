# Ignite CRM — first-release walkthrough

**Live application:** <https://ignite-crm.cfapps.uk/>. The final Phase 7 deployment is intentionally
left running. Cloudflare Access protects the entire hostname; sign in through your organization's
identity provider. Your first sign-in as the `ADMIN_EMAIL` configured in the repository-root `.env`
bootstraps the owner. Other Access-authenticated identities are provisioned read-only unless an
owner assigns another role. Invitations pre-create users and assign roles; **no invitation email is
sent**.

The deployed D1 database starts **empty**. The examples below using Northwind Traders, Priya Shah,
and the five local identities are available only under `pnpm start`: the seed migrations are
local-only and are never deployed. To evaluate the production site, create your own disposable
records from the UI. Do not use real customer information in a demo environment.

## Prerequisites and commands

From the repository root, run `pnpm install` and `pnpm create-env` (if the root `.env` does not
already exist). Set the Cloudflare account, zone, team domain, API token, and `ADMIN_EMAIL`
documented in `.env.example`. Run the following from `cf-terraform-demos/ignite-crm`:

| Command              | Purpose                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm start`         | Migrate and seed the **local** D1 simulation, then start both Workers and the SPA at `http://localhost:5173/`. Local state is `.cloudflare/state`.                                      |
| `pnpm check`         | Types, formatting, linting, Terraform validation, and build.                                                                                                                            |
| `pnpm test`          | 542 Vitest tests with 80%-per-file coverage gate, followed by 20 Chromium E2E checks in a separate local D1 state. On a new machine, run `pnpm exec playwright install chromium` first. |
| `pnpm check:bundles` | Record observational SPA and Worker sizes in `.cloudflare/bundle-report.json`.                                                                                                          |
| `pnpm deploy`        | Provision, migrate, build, and deploy both Workers.                                                                                                                                     |
| `pnpm teardown`      | Delete both Workers **before** Terraform destroys infrastructure. **Do not run after the final demo deployment** unless you intend to remove it.                                        |

The E2E runner uses `.cloudflare/e2e-state` and port 5199, not your `pnpm start` data.
`vite.config.ts` uses `IGNITE_PERSIST_TO` to point Vite at that same migrated state. The root `.env`
is never read by local browsing and is never committed.

## The browser walkthrough

Use `owner@example.com` on the **local** Access login page, or the real `ADMIN_EMAIL` identity on
the deployed hostname. The local page also offers `manager@example.com`, `sales@example.com`,
`delivery@example.com`, and `readonly@example.com`. The responsive navigation drawer opens with the
menu button on mobile; all major routes are also keyboard reachable.

1. **Dashboard and identity.** Confirm the signed-in name and role in the app bar. The dashboard
   shows counts, your next actions, an open pipeline by stage, and recently updated contacts. The
   **Reports** link opens the filterable version. On a fresh production database the counts are
   zero, not seeded examples.
2. **Contact and company.** Open **Contacts → New contact** and enter a first name and a new company
   name. The new contact opens with its next action, deals, projects, activities, notes, and a
   merged timeline. Follow the company link to its overview and back. Locally, open Priya Shah at
   `/contacts/00000000-0000-4000-8000-0000000000b1` and Northwind Traders to inspect populated
   views. Use **Edit contact** or **Edit company** to change details; changing a contact's company
   name moves it (reusing or creating that company), and a stale edit keeps your draft.
3. **Sales.** On a contact, choose **New deal**, enter a title and amount, and save. Open **Deals**
   to see the board and list views; the board's **Move** menu changes the stage with the keyboard
   (no drag/drop). Log a call or meeting from the deal or contact page; multi-contact activities
   appear on every linked customer overview. Set one next action on the contact; **Action stream**
   shows it and its due-date urgency. Use **Done** to complete it. The actor comes from the verified
   Access identity, never a form field.
4. **Win and deliver.** Open a pending deal and select **Mark won/lost**. The dialog defaults to
   **Won** with **Also convert to a delivery project** checked. Submit and follow the new project.
   This closes and converts in **one D1 batch**; the won deal remains a won deal linked to the
   project. Add a task, change its fixed status using the keyboard-first **Move** menu, and inspect
   **My work** as its assignee. Only managers/owners can archive a project; project-status changes
   save immediately, as the hint states.
5. **Notes and search.** Create a note from the project and add another linked contact or company in
   **Linked records**. Switch **Write/Preview**; Markdown is rendered as escaped/sanitized HTML,
   images do not load, unsafe link schemes are not clickable, and task checkboxes are read-only.
   Save, then open **Notes**, search for a word in the title or body, and open the result. The same
   note appears on each linked record. Deleted targets remain labelled tombstones instead of
   breaking the note; the UI does not expose a DELETE action.
6. **Team and audit.** As owner, open **Team**, add a teammate with a read-only role, then assign
   sales or delivery permissions as appropriate. Open **Audit trail** to inspect versioned writes,
   actor, timestamp, and allowlisted metadata. Note bodies and free-text status lines are not in
   audit entries. A manager may read the team and audit pages but only an owner may change
   membership/roles/status. Membership changes are enforced on the next request.
7. **Reports.** **Sales pipeline** shows count/value by stage and won/lost totals. Filter by deal
   owner and an inclusive close-date window (at most 366 days, in the installation timezone); open
   deals have no close date, so only won/lost totals use that window. **Delivery** aggregates task
   statuses and overdue work across active projects; filter by status or lead. Filters are
   bookmarkable in the URL. The report permission is granted to every seeded role, including
   read-only, per the role matrix.

**Mobile:** repeat the contact overview, deal close, task Move menu, note preview, and Reports at a
narrow width. Tables may be horizontally scrollable as a self-contained region, while the overall
page reflows. **Keyboard:** use Tab/Shift+Tab, Enter/Space, Escape, and the **Skip to content**
link. Focus returns to the dialog opener after Escape/Cancel and follows a card moved between board
columns. A live region announces moves and completion.

## Validation and failure checks

These are safe to perform locally, or in production with disposable records:

- Submit a contact without a name or company, a deal without a primary contact, a note without a
  title/body/link, or a task with an invalid due date. The form preserves its draft and displays
  field-specific errors; it does not save partial data.
- Open the same deal or note in two tabs, edit in one, then submit the stale version in the other.
  The second write is rejected rather than overwriting the first; reload the latest version and
  review your draft.
- As a read-only identity, check that mutation controls are absent, but customer pages and Reports
  remain available. A direct mutation is denied by the **Data Worker**, not merely by hidden UI
  controls. As a suspended user, the next authenticated request fails closed.
- Simulated Data Worker outages become retryable RFC 9457 `503` responses without SQL text or stack
  traces. A failed optional notes read returns an explicit warning and a retry button on the
  customer page; a core or authorization failure cannot be downgraded to partial data. A redirected
  HTML Access login after session expiry prompts **Sign in** instead of misreporting a network
  failure.
- `GET /mcp` has no active handler. No MCP/OAuth, Durable Object, R2, or Queue resource is needed
  for release one.

`pnpm test` runs these outcomes offline against production service/repository SQL, a genuine Workers
RPC/D1 runtime, and the browser. `tests/e2e/accessibility.spec.ts` scans 14 pages in both themes on
desktop and mobile for WCAG 2.2 A/AA violations, and checks dialog focus, 24 px targets, 320 px
reflow, and reduced motion. `tests/e2e/csp.spec.ts` runs the SPA under the committed CSP. The review
and each finding's resolution or deferral are in
[`04-mvp-review.md`](../../specs/ignite-crm/04-mvp-review.md).

## Deployment evidence and limits

Phase 7 rehearsal: `pnpm check` and `pnpm test` passed from a clean local state; `pnpm start` and
both desktop/mobile browser layouts worked; `pnpm deploy` succeeded; authenticated `cf` listed both
Workers and D1; `pnpm teardown` removed the Workers first, destroyed three Terraform-managed
resources, and authenticated listings and Terraform state were clean. **Final deployment** was then
run separately and left up: authenticated `cf` lists `ignite-crm-application`, `ignite-crm-data`,
and `ignite-crm-data` D1, with nine Terraform state objects. The custom hostname responds with an
Access redirect when unauthenticated. An authenticated _deployed_ UI smoke test could not be
completed from the in-app browser because its corporate IdP session was not signed in; local
Chromium E2E did exercise both Workers and D1. Do not mistake the Access redirect for a successful
in-app smoke test.

The release SPA entry chunk is about **428.5 kB** (139.5 kB gzip), down from 735.8 kB before the
Phase 6 split. Notes' `marked`/`dompurify` renderer is a separate ~75.0 kB chunk fetched on demand.
See `README.md` for Worker sizes, architecture, lifecycle ownership, security choices, and
trade-offs. Remaining follow-ons include CSV export, pipeline drill-down links and quarterly
reports, rate limiting/FTS before wider exposure, and several review-only refactors recorded in
[`03-follow-ons.md`](../../specs/ignite-crm/03-follow-ons.md).
