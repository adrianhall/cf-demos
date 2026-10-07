# Phase 9 Source Parity Review

**Review date:** 2026-10-07  
**Target:** `cf-terraform-demos/architect`  
**Scope:** Phase 9 only — Layer 1 source parity and four-tier checkpoint.  
**Verdict:** **NOT SIGNED OFF — evidence is strong for the checked Layer 1 code and local flows, but
the required complete real-browser and deployment-lifecycle evidence was not available within this
review. Do not cut over.**

This is a documentation-only review. It makes no application, infrastructure, Access,
deployed-resource, or cutover change.

## Authority and review method

The review used the following authorities:

- `specs/architect/00-introduction.md`, `01-specification.md`, and `02-implementation.md`;
- the surviving source repository at `~/gitlab/cf-demos/demos/architect`;
- the surviving source deployment (whose hostname remains intentionally outside this demo's
  lifecycle) for public desktop and narrow browser comparison;
- the port's local Worker served with `cf dev` on `http://localhost:5174` for desktop review, and
  the local development instance already available on `http://localhost:5173` for authenticated
  Layer 1 flow evidence;
- source/port diffs, static import searches, source and port test suites, and generated coverage.

The source repository now contains later MCP, collaboration, and AI work. Those additions (for
example, AI generation, collaboration controls, remote cursors, and chat) are explicitly outside
this Layer 1/Phase 9 review. Their absence from the port is therefore not a Layer 1 parity defect.

## Quality gates

All commands below were run in `cf-terraform-demos/architect` on 2026-10-07. No deploy, teardown,
Terraform apply/destroy, resource provisioning, or remote mutation command was run.

| Gate                        | Result               | Evidence                                                                                                                                                                                                                         |
| --------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                | PASS                 | Types regenerated and strict `tsc` passed; Oxfmt and type-aware Oxlint passed; naming-contract check scanned 195 files; production CSS/bundle contracts passed 32 tests; `terraform validate` and `terraform fmt -check` passed. |
| `pnpm test`                 | PASS                 | 70 test files and 1,509 tests passed in 8.71 s. The jsdom “Not implemented: navigation to another Document” messages are expected test-environment diagnostics, not failed tests.                                                |
| `pnpm test:coverage`        | PASS                 | 70 test files and 1,509 tests passed. Istanbul total: **99.62% statements** (1600/1606), **99.23% branches** (914/921), **99.58% functions** (485/487), and **99.61% lines** (1537/1543). This exceeds the 80% requirement.      |
| Local real browser          | PARTIAL PASS         | Public landing and blueprints were rendered in a browser at desktop and narrow viewports. An existing local authenticated session permitted dashboard/editor inspection. See browser evidence and limitations below.             |
| Deploy → teardown lifecycle | NOT RUN (prohibited) | The task explicitly prohibited deploy, teardown, provisioning, and mutation of existing resources. Therefore acceptance condition 3 cannot be signed off in this checkpoint.                                                     |

## Four-tier dependency review

### Result: PASS

The reviewed Worker follows the required direction:

```text
Client UI → HTTP/API routes → application services → domain + ports → infrastructure adapters
```

### Composition and adapter construction

`src/worker/index.ts` is the single composition root. It constructs:

- `D1DiagramRepository`;
- `D1KvShareRepository`;
- `D1UserRepository`; and
- `DiagramService`, `ShareService`, `UserService`, and `AdminService`.

It then places the services into request context before it mounts the routers. This is the one
intentional location with knowledge of both concrete adapters and services. Its explicit JSDoc
explains the request-scoped binding rationale and the one-way dependency rule.

### No route-created adapters

Static searches found no `new D1*Repository`, generic `new *Repository`, or infrastructure import
under `src/worker/routes/`. The only repository construction was in `src/worker/index.ts`:

```text
D1KvShareRepository(context.env.DB, context.env.SHARES)
D1UserRepository(context.env.DB)
D1DiagramRepository(context.env.DB)
```

Routes use services supplied by typed `AppBindings`; they do not receive raw D1/KV bindings.

### Import-boundary result

- `routes/` imports Hono, typed bindings, shared body/identity helpers, and route middleware only.
- `application/` imports domain types/validators and port interfaces, but no infrastructure module,
  Hono request/response, or Worker binding.
- `domain/` is pure validation/types/token-digest work and contains no bindings, fetch, storage,
  request, or identity-header access.
- `infrastructure/` implements application ports and imports domain types; it does not import routes
  or application services.
- The client uses only its API modules (`fetch`); it has no D1/KV/DO access.

This satisfies the architecture requirement and the “no route-created repository” exit criterion.

## Fidelity review

### Source-port material review

The Layer 1 port retains the source application shape: React/Vite, a direct `window.location` path
selector, `@xyflow/react`, Zustand, source CSS, the catalogue/blueprint data model, and
component-level units for shell, gallery/modal, dashboard, editor, sharing, administration, exports,
print, and theme. Source/port file comparison shows expected seam differences rather than a
component-family replacement:

- Worker files are intentionally different because this port refactors source feature folders into
  the required four tiers.
- Client differences are accounted for by API response/error seams, Access integration, stronger
  public JSDoc, source regression corrections, and the documented `cf` project scaffold in place of
  the source's obsolete Wrangler scaffold.
- The port stylesheet is otherwise source-equivalent. Its only reviewed additional CSS is the
  deliberate `body` background/text `light-dark()` pair, documented in the file to correct native
  dark/system body-text behaviour; it is covered by the built-CSS contract.
- The source repository has post-Layer-1 feature files such as `GenerateWithAiModal`, MCP,
  collaboration, live sync, remote cursors, and AI chat. These are reserved for later phases and
  were excluded from the parity denominator.

### Behavioural matrix

| Area                          | Result                                                                                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Landing and shell             | PASS (public browser)                                                                      | Source deployment and local port both rendered the Architect header, public navigation, appearance control, hero copy/CTAs, feature sections, and source typography at desktop. The port's authenticated local session correctly changed the shell to verified identity and Sign out.                                                                                                                    |
| Blueprints and create journey | PASS for Layer 1 implementation; browser modal interaction not re-executed                 | Port exposes All/Serverless/AI/Media filters, permanent blank canvas, eight Layer 1 blueprints, real React Flow previews, and `CreateDiagramModal`. Tests cover filters, thumbnail inertness, seed values, close/cancel/Escape equivalence, focus trap/restoration, and dashboard navigation. Source public deployment also displayed later-phase **Generate with AI**, correctly excluded from Layer 1. |
| Dashboard                     | PASS (local authenticated browser)                                                         | `/app` rendered My Diagrams, New Diagram, diagram card, relative/absolute timestamp semantics, preview, and menu control. Tests cover overlays, delete confirmation, navigation, time semantics, and API behaviour.                                                                                                                                                                                      |
| Editor                        | PASS for reviewed implementation; source authenticated side-by-side unavailable            | Local authenticated editor rendered the source-shaped single toolbar, no app-shell banner, title control, palette, canvas, status bar, named icon controls, Connect nodes dialog trigger, export/share/print/theme controls, and React Flow canvas. Tests cover graph store/history/autosave, connection handling, palette/panels, exports, printing, accessibility, and 35 source regressions.          |
| Sharing                       | PASS by code/tests; public source-port link comparison unavailable                         | Dedicated share API/service/port and read-only `ShareView` exist. Unit/runtime tests cover one-time raw token disclosure, digest-only D1/KV/log handling, owner isolation, public live-pointer resolution, revocation, malformed/unknown/deleted indistinguishable 404s, and read-only controls. No share token was created during this review.                                                          |
| Administration                | PASS by code/tests; live privileged comparison unavailable                                 | `ADMIN_EMAIL` is rechecked in middleware/routers; `AdminService` and D1 user adapter provide directory/moderation. Unit/integration/client tests cover admin/non-admin outcomes, table semantics, and moderation share cleanup. No privileged local or source resource was mutated.                                                                                                                      |
| Theme                         | PASS (browser and contracts)                                                               | Source and port expose the three-state appearance control. The port browser showed System/Dark states; `theme.test.ts`, `DarkModeToggle.test.tsx`, and built CSS contracts cover System → Light → Dark → System, fixed control dimensions, `color-scheme`, and unlowered `light-dark()`.                                                                                                                 |
| Narrow viewport               | PASS for observed public views; editor geometry relies on existing manual/browser evidence | The source was reviewed at 390 × 844 and the port CSS source/built-contract tests retain source breakpoints. Existing `BUG-AUDIT.md` browser record documents a 390 px editor canvas with overlay drawers, padded properties panel, and first-fit geometry. The present review did not independently authenticate a fresh narrow editor/source session.                                                  |

## Browser observations

### Surviving source deployment

- At desktop width, the public landing page rendered expected hero, CTA, header, source styling, and
  anonymous Sign in posture.
- The source public `/blueprints` page rendered the expected Layer 1 gallery content and categories.
  It additionally rendered **Generate with AI**, which confirms that the reference has progressed
  beyond Phase 9 rather than indicating a missing Layer 1 port feature.
- At 390 × 844, the source blueprint gallery remained readable with its responsive card layout.

### Local port

- At desktop width, `http://localhost:5174/` rendered the source-faithful landing page using the
  port's real CSS and local Access identity shell.
- The local authenticated `/app` dashboard rendered a saved diagram card and the expected controls.
- The local authenticated `/app/diagram/:id` rendered a full editor with a diagram-specific heading,
  palette, canvas, status bar, named toolbar controls, and no duplicate application header.
- The browser console reported React Flow’s attribution-removal subscription warning. This is a
  pre-existing library warning, not a parity/test failure, but should be resolved by confirming the
  project’s React Flow Pro entitlement or restoring attribution before a release.

## Layer 1 acceptance-condition disposition

| Specification §7 condition                            | Disposition                                                                                                                                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Check, test, coverage pass                         | PASS                                                                                                                                                                                               |
| 2. `pnpm start` after root `.env`, real CSS           | PARTIAL PASS — local `cf dev` served real CSS; a clean-checkout/root-`.env` recreation was not performed in this non-mutating review.                                                              |
| 3. Idempotent deploy then teardown, clean account     | NOT VERIFIED — intentionally not run because it would mutate/deploy resources and is prohibited by this task.                                                                                      |
| 4. Access/audience, origins, JSON mutations           | PASS by focused worker/runtime tests and shared middleware composition.                                                                                                                            |
| 5. Non-enumerating owner isolation                    | PASS by diagram/share integration and application-service tests.                                                                                                                                   |
| 6. `ADMIN_EMAIL` exclusively accesses admin endpoints | PASS by admin service/router/runtime tests.                                                                                                                                                        |
| 7. Digest-only, one-time raw share token              | PASS by token, service, repository, logging, and integration tests.                                                                                                                                |
| 8. Accessibility fixes                                | PASS by component/built-CSS coverage and the Phase 7 regression audit; present browser review did not repeat every keyboard/focus/motion interaction.                                              |
| 9. Visual/component interaction parity                | PARTIAL PASS — broad source/local browser and source-code comparison completed; authenticated source admin/editor/share and complete fresh narrow-flow side-by-side comparison remain unavailable. |

## Limitations and required follow-up before sign-off

1. **Do not cut over.** Phase 9 explicitly reserves cutover for a separate change after sign-off;
   this review does not meet the evidence threshold for that action.
2. Execute the separately authorized lifecycle evidence: clean environment `pnpm start`, then
   idempotent `pnpm deploy` and `pnpm teardown`, verifying the account is clean. This review did not
   and must not do it.
3. With an authorized non-production identity/session, complete side-by-side source vs port browser
   checks for authenticated dashboard, creation modal, editor (drag, pointer connection, keyboard
   connection, fit view, autosave), share viewer, and admin at desktop and 390 px. Capture results
   as review evidence, without creating/modifying source production data.
4. Repeat browser-only checks from `BUG-AUDIT.md`: painted focus, contrast in all appearance modes,
   modal trap/restoration, reduced motion, responsive overlay geometry, canvas fit, and hit-test
   stacking. The existing Phase 7 record is useful evidence but does not replace this checkpoint’s
   complete side-by-side session.
5. Resolve or explicitly document the React Flow attribution warning before a release; hidden
   attribution must be backed by the appropriate subscription.

## Conclusion

The inspected implementation is structurally compliant: the routes do not construct adapters, the
composition root is the sole concrete-adapter wiring point, and dependencies flow downward through
routes, application services, domain/ports, and infrastructure. Automated gates are clean and
coverage is substantially above the required threshold. The checked public and local authenticated
browser surfaces match the expected Layer 1 design and interaction inventory, with later source
features correctly excluded.

However, this cannot be a full Phase 9 sign-off because the task prohibits the deploy/teardown gate
and the review could not complete authenticated source-side and fresh narrow-viewport browser
comparisons for every specified surface. The correct checkpoint verdict is therefore **not signed
off / no cutover**, pending the listed authorized evidence.
