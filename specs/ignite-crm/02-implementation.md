# Ignite CRM — Phased implementation plan

## 1. Purpose and delivery rules

This plan implements the authoritative two-Worker design in
[`01-specification.md`](./01-specification.md) and the product scope in
[`00-introduction.md`](./00-introduction.md). The previous seven-Worker design under
[`microservice-experiment/`](./microservice-experiment/) is reference material only; no phase
implements it.

Each phase must produce a coherent review increment rather than an invisible layer of technical
work. At the end of every phase, a reviewer must be able to run the application locally and see a
useful, working part of the CRM. When credentials and the account are available, the same increment
must also deploy through the normal lifecycle and be removable with teardown.

### 1.1 Non-negotiable rules for every phase

1. Work test-first for every main interface. Write a failing test that calls the public domain,
   application-service, RPC, HTTP, or browser-client interface; demonstrate the failure; implement
   the smallest behaviour that makes it pass. Tests must describe observable outcomes rather than
   private helpers or SQL implementation details.
2. Each main use-case pattern has explicit happy-path **and** error-path tests before its production
   implementation: validation failure, unauthenticated/unauthorized caller, absent resource,
   conflict/version mismatch, and dependency failure where that interface exposes one. Do not defer
   these interface behaviours to a final coverage exercise.
3. A small number of unusual boundary and combinatorial tests may be added after implementation, but
   deliberately defer the broad corner-case sweep to Phase 7. Do not manufacture tests solely to
   increase a percentage or claim that coverage represents unreviewed behaviour.
4. `pnpm check` and `pnpm test` pass before closing every phase. `pnpm check` includes generated
   Worker type freshness, strict TypeScript, `oxfmt --check .`, type-aware Oxlint, Terraform
   validation/formatting, and dry builds. `pnpm test` runs the complete test suite **with Istanbul
   coverage enabled**, not a non-coverage subset.
5. Istanbul measures every authored runtime source file under `src/**/*.{ts,vue}`. Its only
   exclusions are test files, generated declaration files, and configuration files outside `src`. It
   must not omit Workers, composition roots, D1 adapters, Vue components, route files, or files
   merely because they are inconvenient to exercise. `pnpm test` enforces a minimum of 80% lines,
   functions, statements, and branches for that complete source set. The coverage report is retained
   for review; `pnpm test:coverage` may be an alias of `pnpm test`, not a weaker optional gate.
6. Keep coverage meaningful: test the interface that reaches a source file. For example, exercise a
   route through its Hono application, a Data Worker adapter through Workers-runtime integration, a
   client view through DOM interaction, and a configuration/error branch through its consuming
   interface. A direct import-only test is insufficient unless the module is intentionally pure.
7. Keep the four-tier direction intact: client → Application Worker API → Data Worker application/
   domain → infrastructure. Route handlers never construct repositories. The Application Worker
   never receives D1. The Data Worker is reached only through the one grouped `DATA_SERVICE` RPC
   binding.
8. Use Valibot for every runtime schema. Shared API schemas validate Application Worker input and
   output as well as untrusted SPA responses. No Zod, Wrangler, demo-local `.env`, live-service
   test, or MCP runtime dependency may be introduced.
9. Build every user interface from Vuetify
   ([specification §10.1](./01-specification.md#101-component-library)). When Vuetify has no
   suitable component, add a general-purpose component in `src/client/components` built in Vuetify's
   style: composed from Vuetify primitives, consuming its theme tokens and density, matching its
   accessibility behaviour, exposing a documented reusable props/emits/slots API, and covered by its
   own DOM tests. Prefer adapting a near-miss Vuetify component over authoring a bespoke one, record
   each exception in the README, and never add a second component or CSS framework.
10. Run `pnpm start` using local D1 state before review. Confirm the UI in a browser at desktop and
    narrow widths, including keyboard operation for the increment. Run `pnpm deploy` then
    `pnpm teardown` at the listed deployment checkpoints; never leave account resources behind.
11. Add complete JSDoc as code is authored, including exported types, functions, classes, and
    meaningful non-exported logic. Update `README.md` as decisions become visible to a user or
    operator rather than postponing all documentation to the last phase.

### 1.2 Test and coverage bootstrap

Phase 1 establishes these project-wide conventions before the application grows:

- Vitest has unit, DOM/client, contract, and Workers-runtime integration projects. The integration
  project has a finite 30-second timeout. Playwright is added when browser flows exist.
- `@vitest/coverage-istanbul` is installed and configured at the root Vitest configuration. It
  includes `src/**/*.{ts,vue}` and has global 80% thresholds for branches, functions, lines, and
  statements. No per-file exclusions or negative globs are used to hide production code.
- `pnpm test` invokes `vitest run --coverage`; the normal green test command therefore proves the
  coverage gate. A phase may temporarily need tests for scaffold code before it introduces that
  code; it may not lower the threshold.
- Fakes implement public ports and pass the same shared contract tests as the real Data Worker where
  applicable. Fixtures represent wire values, not database rows or implementation internals.
- Test names state the user-visible or caller-visible result. A test added after implementation is
  labelled as a hardening/corner-case test in its description or neighbouring comment when that is
  relevant to reviewers.

## 2. Phase 1 — Deployable foundation, identity, and first CRM journey

### Goal

Deliver the large initial vertical slice needed to verify the whole architecture: a locally runnable
and deployable two-Worker CRM with Access-equivalent local authentication, a real D1 database, RBAC,
a Vue shell, and a signed-in owner able to create, list, search, and view contacts and companies.
This is intentionally broad: it validates the seams that every later phase relies on before features
multiply.

### Deliverables

1. Create `cf-terraform-demos/ignite-crm` as a pnpm workspace package with strict TypeScript, Vue 3
   Composition API, Vuetify, Vite, Hono, Valibot, Vitest, Istanbul, Cloudflare Vite tooling, `cf`,
   Terraform, Oxfmt, type-aware Oxlint, and `@demos/worker-common`. Use deliberate/pinned prerelease
   versions where necessary and do not add MCP SDK, Zod, or a second component/CSS framework.
2. Establish both Worker configurations: Application Worker static assets/API plus Data Worker
   private RPC service. Generate types for both configurations and include generated type files in
   TypeScript. Configure the pinned compatibility date, `nodejs_compat`, structured observability,
   the `DATA_SERVICE` binding, and the Data Worker's D1 binding.
3. Implement Terraform split by concern: providers, Access, Application Worker
   registration/bootstrap and hostname, Data Worker registration, D1, and documented scalar outputs.
   Configure `ignite-crm.cfapps.uk`; committed `infra/local-outputs.json` enables local work without
   account state. `cf` owns builds/uploads and Terraform owns infrastructure only.
4. Add the one migration stream and repository-root migration helper scripts. Create STRICT D1
   tables and seed data for users, roles, role permissions, user roles, companies, contacts, audit
   events, and idempotency records. Provide known development identities/roles through the existing
   local Access emulation pattern, never an unverified header or a committed secret.
5. Implement `src/configuration.ts`, validated by Valibot at startup, with the specified safe UK
   defaults. Add a safe API configuration DTO so the SPA gets formatting information without
   directly importing server configuration.
6. Define the runtime-neutral `src/shared` foundation: identifiers, dates, RFC 9457 values,
   pagination, common Valibot validators, API problem/session/CRM schemas and DTOs, and the one
   grouped Data Worker contract. Define service errors as serializable values.
7. Implement Permissions first: its port, seeded-role evaluation, actor resolution, authorization
   decisions, and audit correlation. Implement CRM company/contact use cases through repository
   ports and the D1 adapter. They must enforce role permissions, create/reuse a company during
   contact creation, and preserve company/contact visibility boundaries.
8. Implement `DataEntrypoint` and composition root around the grouped contract. The Application
   Worker composes shared Access middleware, safe identity extraction, same-origin and JSON-body
   protections, RFC 9457 mapping, `/api/me`, `GET /api/v1/session`, health, configuration,
   contact/company create, list, get, and bounded search routes. Input and output always pass shared
   schemas.
9. Build a useful SPA rather than a placeholder: application shell/navigation, signed-in identity
   and role display, dashboard counts, contacts list/search, company/contact detail, and accessible
   create-contact form. It uses a typed same-origin client that rejects malformed server responses.
   Use loading, empty, error, and permission-denied states. Display dates/currency according to the
   configuration DTO.
10. Establish the Vuetify foundation every later phase builds on
    ([specification §10.1](./01-specification.md#101-component-library)): explicit named component
    and directive registration in `src/client/main.ts`, one application theme owning colour,
    density, spacing, and typography, and Vuetify primitives for all shell, navigation, list, table,
    form, dialog, and feedback surfaces. Inline Vuetify in the Vitest client project and mount
    components with a real `createVuetify()` instance. Vuetify must not be imported outside
    `src/client`.
11. Add required lifecycle scripts: `start`, `check`, `fix`, `test`, `deploy`, and `teardown`,
    composed with `run-s` and individually runnable substeps. `start` runs local migration then
    `cf dev --persist-to .cloudflare/state`; deployment applies Terraform, writes outputs, runs
    remote migration, builds and uploads Data then Application; teardown deletes Application before
    Data and destroys Terraform resources.

### Test-first interface work

- Define and test Valibot API/RPC schemas before routes and client calls exist, including malformed
  UUIDs, invalid paging/search inputs, invalid configuration, and RFC 9457 shapes.
- Define a `PermissionsPort` fake and test resolved identity, owner/sales/read-only outcomes,
  authorization denial, and failed-closed permission dependency behaviour before the D1 adapter.
- Define CRM service/repository ports and tests for create/list/get/search, company reuse, invalid
  input, inaccessible/missing records, idempotency replay/conflict, and optimistic-version conflict.
- Test the Data Worker contract against a fake first, then run the same suite against the real
  `DataEntrypoint`. Workers-runtime tests prove migrations, parameter-bound D1 behaviour, and
  service binding operation.
- Test Application HTTP behaviour through the Hono app: development Access identity succeeds;
  missing, wrong-audience, expired, and smuggled identity cases fail safely; malformed payloads,
  missing idempotency key, Data Worker outage, and service errors become correct problem details.
- Test client API response validation, contact searching/creation, keyboard form operation, and
  loading/error/empty states with the public HTTP-client interface.

### Something to review

Run `pnpm start`, sign in through local Access emulation, create a contact and its company, find it
in search, and open its detail page. A reviewer can see the identity/role, formatting configuration,
audit-visible creation, real local D1 persistence after reload, and a clear denied-action state for
a read-only identity. Run `pnpm deploy` to review the same bounded CRM journey at
`ignite-crm.cfapps.uk`, then `pnpm teardown` to prove lifecycle ownership.

### Exit criteria

All required scripts work from a clean checkout with the root `.env`; `pnpm check` and
coverage-gated `pnpm test` pass at or above 80% across all of `src`; local and deployed Application
Workers reach the Data Worker only through typed RPC; and the first contact/company journey is
usable without a mocked production path.

## 3. Phase 2 — Sales workflow: deals, activities, and action stream

### Goal

Make the CRM useful for day-to-day sales: contacts become deals, interactions are recorded in their
real multi-linked shape, and a salesperson has an actionable follow-up view.

### Deliverables

1. Add migrations, shared schemas, domain values, ports, D1 adapters, and CRM use cases for
   pipelines, stages, deals, activities, activity contacts, and follow-ups. Seed a small fixed
   pipeline suitable for review.
2. Implement contact/company/deal searches and detail projections without N+1 RPC calls. Add deal
   state, status line, independent primary contact, owner, next-action text/date, and money in minor
   units.
3. Implement call/meeting creation with multiple contacts and optional company/deal. Validate all
   linked records and visibility inside one transaction; persist an audit event and idempotency
   result with the activity.
4. Add the action stream: contact and deal next actions ordered for the signed-in actor, including
   overdue and due-today presentation. Add bounded pipeline summary/report API data.
5. Expand the SPA with customer timeline, deal list/detail/editor, pipeline view, activity form,
   multi-contact picker, and action stream. Keep keyboard alternatives for every
   selection/reordering control and show conflicted form drafts rather than discarding them.
6. Build these screens from Vuetify data tables, lists, forms, autocompletes, chips, and dialogs.
   Anything Vuetify cannot supply — notably the action-stream row and any pipeline column layout —
   becomes a reusable Vuetify-styled component in `src/client/components` with a documented
   props/emits API and its own DOM tests, per
   [specification §10.1](./01-specification.md#101-component-library).

### Test-first interface work

- Write domain/application tests for valid deal lifecycle changes and reject invalid status/stage,
  absent primary contact, stale version, unauthorized reassignment, and duplicate/different
  idempotency-key uses.
- Test multi-linked activity creation before adapter implementation: all links persist together, an
  invalid or invisible target rolls back everything, and calls/meetings surface from every linked
  context.
- Test action-stream ordering and date-only validation with a controllable clock; test empty and
  forbidden report responses.
- Test each route and SPA client against the shared request/response schema; test 409 draft
  preservation, server validation display, and keyboard use of activity/contact controls.

### Something to review

A sales-role reviewer can create a deal for the Phase 1 contact, set a next action, log one meeting
linked to two people and its deal, then see that meeting from each relevant record and see
overdue/due work on the action stream. An owner can view the pipeline summary; a read-only user sees
only allowed operations.

### Exit criteria

The contact-to-deal-to-follow-up sales loop works locally and in a deployed review environment.
Every main mutation demonstrates idempotency/version error behaviour through tests, and coverage
remains at least 80% over the enlarged complete `src` set.

## 4. Phase 3 — Delivery: atomic won-deal conversion and task board

### Goal

Demonstrate the architectural reason for the shared Data Worker database: converting a won deal into
delivery work is atomic, visible, and useful rather than a distributed partial-success exercise.

### Deliverables

1. Add project, task, and conversion-attempt migrations, shared API/RPC contracts, domain status and
   priority rules, repository ports, and D1 adapters.
2. Implement the deal-to-project conversion use case as the specified single transaction: authorize,
   confirm a won/unconverted deal, create project/conversion record, link deal, audit, store
   idempotency result, and commit. Expose no pending/saga state.
3. Implement project detail, task create/update/list, assignee/due-date/status/priority, and the
   signed-in user's cross-project worklist. Enforce delivery and sales permissions through the
   Permissions module.
4. Add project/task routes and composite customer overview projections through the Application
   Worker. Expand the SPA with conversion confirmation/result, project overview, accessible task
   board/list, task editor, and personal task view. Drag/drop, if used, has a keyboard status-change
   equivalent.
5. The Linear-style task board is the main expected Vuetify gap. Implement it as a reusable,
   Vuetify-styled board component in `src/client/components`, composed from Vuetify cards, chips,
   menus, and layout primitives, consuming theme tokens and density, with documented props/emits,
   full keyboard status changes, and its own DOM tests. Use Vuetify components directly for task
   lists, editors, and the personal worklist; record the board exception in the README.

### Test-first interface work

- Define conversion contract tests before implementation: a won eligible deal returns a linked
  project; pending/lost/already-converted/stale/forbidden cases are rejected with stable service and
  HTTP error codes.
- Use injected fake transaction ports to prove every failure after transaction start rolls back the
  project, link, audit, and idempotency rows. Confirm the real D1 integration path has the same
  outcome.
- Test task workflow transitions, invalid priorities/dates, assignee visibility, and per-role
  authorization via public application interfaces.
- Test SPA conversion, conflict/error recovery, board/list keyboard transitions, task worklist, and
  customer overview response validation.

### Something to review

A reviewer wins a deal from Phase 2, converts it once into a linked project, creates and progresses
tasks, and sees the task both on the project and personal worklist. The customer detail shows sales
and delivery context together. A forced invalid conversion leaves no half-created project.

### Exit criteria

The conversion path is backed by one D1 transaction and its rollback contract is proved in unit and
Workers-runtime tests. The full user-visible workflow deploys and remains above the universal 80%
Istanbul gate.

## 5. Phase 4 — Multi-linked Markdown notes and search

### Goal

Deliver the connected knowledge feature: users write a single safe Markdown note, link it to
multiple business records, find it through FTS search, and view it from those contexts.

### Deliverables

1. Add notes, note links, FTS5 table, and FTS triggers in migrations. Implement Notes
   ports/adapters, bounded search, link validation, and safe result projections. Keep raw D1/FTS
   details inside infrastructure.
2. Implement atomic note create/update/link workflow: validate 2–200-character searches, up to 64
   KiB Markdown body, at least one typed contact/company/deal/project link, target
   existence/visibility, authorization, audit digest, idempotency, and versioning in one
   transaction.
3. Define the Markdown subset and safe rendering configuration: HTML disabled, allowlisted
   protocols, no dangerous output inserted into the DOM. Add notes to customer/project/deal context
   projections with bounded pagination and explicit partial-warning behaviour where permitted.
4. Add SPA note composer/editor, typed multi-record link chooser, context note feeds, result page,
   and rendered note view. Make link removal/editing and error states accessible without relying on
   a pointer interaction.
5. Build the link chooser on Vuetify autocomplete/chip/list primitives where it can be, and the
   Markdown composer and rendered-note surface as reusable Vuetify-styled components in
   `src/client/components` with documented props/emits and their own DOM tests. They must use
   Vuetify theme tokens, density, and field/validation presentation so they read as part of the same
   library, per [specification §10.1](./01-specification.md#101-component-library).

### Test-first interface work

- Write the note service contract against a fake repository before D1 code: multiple valid links
  create one note; no links, duplicate/unsupported links, unavailable targets, forbidden actor,
  stale update, and repeated/conflicting idempotency requests fail predictably.
- Test atomic rollback at every link-validation/write stage. Test FTS query escaping and bounds
  through repository/application interfaces, not by asserting implementation SQL strings.
- Test Markdown rendering rejects HTML and unsafe URLs, while expected headings/lists/emphasis/check
  lists and safe links render correctly.
- Test API and SPA response schemas, multi-link form keyboard behaviour, search loading/empty/error
  states, and notes appearing in each linked context.

### Something to review

Create one meeting note linked to two contacts, their company, the deal, and its project. Search a
word from the note, inspect its linked context, then open the same note from each record. Review the
safe rendered Markdown and an invalid-link/error path.

### Exit criteria

Notes and their links are atomic, searchable, safely rendered, and visible only to authorized users.
`pnpm check` and coverage-gated `pnpm test` remain green with every newly authored source file
counted.

## 6. Phase 5 — Team administration, RBAC management, and audit

### Goal

Turn seeded RBAC into an operable small-business team model: owners manage roles, all users see the
correct capabilities, and privileged reviewers can trace important changes.

### Deliverables

1. Add user/role assignment administration interfaces and any needed migrations while retaining the
   fixed seeded roles: owner, manager, sales representative, delivery/project contributor, and
   read-only/reporting.
2. Implement owner-only invite/provision and role-change use cases. Invitation may initially create
   or enable a known Access identity rather than sending email; email delivery is not introduced.
   Role changes are authoritative on the next request.
3. Add role summaries/capability hints to session data, but retain Data Worker authorization on
   every relevant operation. Add owner/manager audit list route with bounded cursor and safe
   before/after metadata; never expose note body text.
4. Build the team directory, role assignment UI, capability-aware controls, and audit viewer from
   Vuetify data tables, selects, dialogs, and chips; no new custom component is expected here. Keep
   forbidden-state handling clear. Capability hints improve usability but never replace an API
   decision.

### Test-first interface work

- Test owner invite/role changes through the public service API before implementation: only owners
  succeed; unknown/duplicate identities, invalid roles, and stale/missing updates fail correctly.
- Define a role-permission matrix fixture and exercise each critical CRM, project, notes, reporting,
  administration, and audit operation through it. Test an immediate next request reflects a changed
  role.
- Test audit projection redaction and paging, including note digest rather than note content.
- Test client capability hints versus server denials, role form validation, keyboard operation, and
  audit filtering/paging. Runtime tests must include wrong Access audience/identity cases.

### Something to review

As an owner, add a local-review teammate or change their role, then open a second session with that
identity to show the permitted UI and enforced server boundary changing immediately. Inspect an
audit trail for a contact, deal, project, and note mutation without seeing sensitive note text.

### Exit criteria

RBAC is demonstrably enforced below the UI and administration/audit are usable locally and after
normal deployment. The matrix's happy and denied interface cases are explicit tests, not inferred
from coverage.

## 7. Phase 6 — Reports, refinement, and release-ready SPA

### Goal

Complete first-release user workflows and turn the incremental UI into a coherent, responsive CRM
that a reviewer can use end-to-end.

### Deliverables

1. Complete pipeline health reporting (counts/value by stage) and delivery health reporting (task
   counts by status across active projects) with bounded filters and owner/manager authorization.
2. Complete customer overview: company/contact timeline, deals, activities, next actions, linked
   projects, and linked notes. Use bounded parallel Data Worker RPC reads where beneficial and
   return explicit partial warnings only for allowed optional sections; authorization failures never
   become partial data.
3. Finish navigation, empty/loading/error/retry/409-conflict states, responsive layouts, semantic
   landmarks/headings/form labels, focus management, target sizes, reduced motion, and keyboard
   equivalents for all released interactions. Validate desktop and mobile browser behaviour. Use
   Vuetify's responsive layout, navigation, and density system rather than bespoke breakpoints or
   ad-hoc CSS.
4. Audit the component inventory: confirm each custom component still has no suitable Vuetify
   equivalent, is composed from Vuetify primitives, honours the shared theme in light and dark
   modes, and has a reusable documented API. Replace or fold back anything that duplicates a Vuetify
   component, and confirm Vuetify registration still lists only components the SPA uses.
5. Add bundle-size recording with `check:bundles`; record actual SPA/Application/Data build sizes in
   project documentation or CI artifact. Do not create free-tier account-limit assertions.
6. Split the Markdown libraries (`marked` and `dompurify`) out of the main SPA chunk into their own
   bundle(s), loaded only when a view first renders or composes Markdown (the note page, the
   composer preview, and context note feeds), so the initial SPA load no longer carries them and the
   build's 500 kB chunk warning is resolved rather than suppressed. Use a dynamic `import()` behind
   `src/client/services/markdown.ts` (or an equivalent Vite/Rolldown chunking rule), keep that
   module the single Markdown-to-HTML boundary, and show an accessible loading state while the chunk
   loads. Record the before/after chunk sizes with `check:bundles`, and keep the Markdown safety
   tests passing against the lazily loaded renderer.
7. Complete README documentation: prerequisites; local setup; local development identities; test and
   coverage policy; architecture; D1/transaction trade-off; deploy/teardown; configuration; security
   model; MCP deferral; the Vuetify component-library decision with each custom-component exception
   and its justification; and known intentional scope limits.

### Test-first interface work

- Test report and customer-overview contracts for authorized success, invalid filters, forbidden
  caller, core Data Worker failure, and permitted optional-section partial response.
- Test the Application Worker maps Data Worker retryable failures to safe 503 problem details and
  does not leak internals. Test all shared DTOs through server serialization and SPA response
  parsing.
- Add DOM tests for every primary navigation path, responsive menu semantics where testable, focus
  restoration, form error announcements, conflict drafts, and keyboard-only task/note/activity
  flows.
- Run offline Playwright journeys: identity → contact/company → deal/activity/action → win/convert →
  task → multi-linked note/search → audit/report. Cover desktop and mobile viewports.

### Something to review

Review a polished end-to-end CRM: create customer context, work a sale, convert it to delivery, keep
notes, manage a teammate, and inspect business health reports. Run it in desktop and mobile layouts,
then deploy it to the custom hostname and use the documented teardown.

### Exit criteria

Every Must-have first-release browser workflow in the introduction is executable and understandable
from the SPA. Documentation is sufficient for a clean checkout. The observation-only bundle report,
all checks, and 80%-minimum complete-source Istanbul gate pass.

## 8. Phase 7 — Hardening and corner-case completion

### Goal

Perform the deliberately deferred corner-case sweep without confusing it with the main test-first
interface design. Complete a review using the provided agents for security, accessibility, system
architecture, and code. Harden correctness, recovery, accessibility, security, and operations for the
finished first release.

### Deliverables

1. Review Istanbul output module by module. For every uncovered production branch, either add a
   meaningful boundary/corner-case test through its public interface or simplify/remove unreachable
   production code. Do not exclude it from coverage merely to reach the threshold.
2. Add focused edge-case tests: Unicode/boundary lengths; date/timezone boundaries; cursor edges;
   deleted/soft-deleted linked records; simultaneous stale writes; idempotency retention/replay; FTS
   punctuation; company primary-contact reassignment; transaction error paths; pagination limits;
   partial RPC timeout; and service-error serialization.
3. Perform a security review: Access audience/expiry/header-smuggling checks, origin/CSRF posture,
   input/output validation, safe Markdown links, error/log redaction, SQL allowlists/parameters,
   least-privilege Terraform, and Data Worker non-public reachability.
4. Perform WCAG 2.2 AA review in a real browser: contrast, headings/landmarks, keyboard flows,
   focus, form errors, target sizes, reduced motion, zoom/reflow, and screen-reader-relevant names.
   Cover custom Vuetify-styled components to the same standard as Vuetify's own, in both themes. Fix
   concrete findings and add regression tests where automation is appropriate.
5. Run performance/failure review: measure local expected paths, verify bounded RPC/data access and
   no N+1 patterns, exercise Data Worker outage/retryable response paths, inspect production
   bundles, and confirm no MCP/OAuth/DO/R2/Queue dependency slipped in. Confirm the SPA bundle
   carries only the registered Vuetify components and no second component or CSS framework.
6. Rehearse lifecycle from a clean state: `pnpm check`, `pnpm test`, `pnpm start`, full local E2E,
   `pnpm deploy`, deployed smoke test, and `pnpm teardown`. Verify account cleanup and update README
   with measured bundle observations and remaining product limitations.

Use the review-orchestrator agent for reviews, storing the resulting review output in
`specs/ignite-crm/04-mvp-review.md`

### Something to review

The reviewer receives an evidence-backed release candidate: full tests and Istanbul report, a short
security/accessibility/performance findings record, browser walkthrough, deployed smoke test, and a
clean teardown. Boundary failures are demonstrated as controlled problem details or accessible UI
feedback rather than crashes.

### Exit criteria

The finished first release satisfies [`01-specification.md`](./01-specification.md): two Workers,
one D1 database, typed RPC, Access plus RBAC, CRM/projects/notes/audit/reporting workflows, no
active MCP endpoint, clean lifecycle, and complete documentation. `pnpm check` and
coverage-enforcing `pnpm test` pass offline with at least 80% Istanbul branch, function, line, and
statement coverage across every authored `src` runtime file.

## 9. Follow-on boundary

MCP is intentionally not a Phase 1–7 deliverable. A future release begins with a separate design and
compatibility/authentication spike for the reserved `/mcp` route. It must retain the grouped Data
Worker contract and reuse the established authorization, schema, idempotency, audit, and test
principles without compromising this first-release lifecycle.
