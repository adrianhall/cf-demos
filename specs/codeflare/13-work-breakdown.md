# 13 — Swarm work breakdown

## 1. Dependency graph

```text
P0 scaffold/config ─┬─ P1 domain/contracts ─────┬─ P3 identity/API ─┬─ P6 frontend shell
                    │                           │                   ├─ P7 project UI
                    │                           │                   └─ P8 session UI
                    │                           ├─ P4 storage/git ──┬─ P9 merge/publish
                    │                           │                   └─ P10 CI
                    │                           └─ P5 SessionDO ────┬─ P8 session UI
                    │                                               └─ P11 terminal/preview
                    └─ P2 platform infra ───────────────────────────┴─ P11 terminal/preview

P12 security review/test hardening depends on all packages.
P13 documentation/release depends on all packages.
```

Packages labelled parallel have no file overlap other than frozen contracts. They may be assigned to
separate agents/worktrees. Do not start a package before the listed prerequisite is merged unless it
can work solely against its interfaces and fixtures.

## 2. Shared rules for every package

- Read [`README.md`](./README.md), documents 00–05, and this package card before changing code.
- Obey repository-root `AGENTS.md` and create `codeflare/AGENTS.md` in P0 before other code lands.
- Use pnpm only; `cf` only; never Wrangler.
- Do not change a frozen public contract in [10-api-contracts.md](./10-api-contracts.md) without a
  written cross-package decision.
- New/changed exports have complete JSDoc per root policy.
- Add tests named with the requirement IDs the package owns.
- Run the narrowest relevant tests during development; P0/P12 runs full `pnpm check`/`pnpm test`.
- Do not add a dependency just to avoid a first-party Cloudflare capability.

## 3. Package cards

### P0 — Codeflare scaffold and developer contract

**Depends on:** none

**Owns:** `codeflare/` skeleton, package scripts/config, family `AGENTS.md`, README, Vite/vinext/cf
wiring, type generation, formatting/linting, test harness.

**Requirements:** NFR-DX-010, NFR-DX-020, NFR-SEC-040 (error middleware scaffold), root required
scripts.

**Deliverables:**

- `codeflare/package.json` exact required script shape.
- `cloudflare.config.ts` typed configuration skeleton; intentionally no handcrafted generated types.
- Vite plugin ordering: toolkit Access plugin → vinext → Cloudflare Vite plugin.
- `oxlint.config.ts` extends root baseline, enables TypeScript/react type-aware rules.
- Strict `tsconfig`: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`.
- Hono app adapter route and toolkit RFC 9457 error/not-found middleware.
- Testing setup: Vitest unit/UI/integration config.
- `codeflare/README.md` with prerequisites and commands.
- Family `AGENTS.md` explicitly says “cf only, never Wrangler”, links to the specification, and
  captures vinext family rules relevant to Codeflare.

**Acceptance:** Fresh local checkout reaches a protected placeholder page through `pnpm start` with
local Access emulation. `pnpm check` passes and does not write working files. No product logic.

**Parallelism:** Must land first. Keep scope narrow — do not pre-implement domain or infrastructure.

---

### P1 — Domain model, validation, ports, contracts

**Depends on:** P0

**Owns:** `src/domain/`, shared API/RPC DTO package, all state machines and validation.

**Requirements:** all entity/state/validation requirements in 03; FR-AUTH-030/040/050 semantics;
FR-SESS-060; FR-GIT-060/070 semantics; FR-OPS-050; NFR-SEC-020 policy model.

**Deliverables:**

- Entities/types exactly from [03-domain-model.md](./03-domain-model.md).
- Zod schemas for transport inputs and explicit domain constructors.
- Port interfaces: project/session/git/sandbox/model/secrets/audit.
- Session transition service with side-effect commands abstracted as ports.
- Budget service, approval policy, egress policy, remote/ref validation, merge-queue policy.
- Domain events and typed event envelope.
- Fakes for every port, reusable by all tests.

**Acceptance:** Pure unit suite covers state transitions, validation, budget, egress, approvals,
merge serialization policy. No Cloudflare imports within domain files.

**Parallelism:** Can proceed alongside P2 once P0 is merged.

---

### P2 — Platform configuration and infrastructure adapters foundation

**Depends on:** P0

**Owns:** `cloudflare.config.ts` completion, D1/KV/R2/Artifacts/Secrets binding adapters, migrations,
configuration lifecycle scripts.

**Requirements:** FR-OPS-110; D1 root requirements; NFR-SEC-050; NFR-DX-010/020.

**Deliverables:**

- D1 schema/migrations: projects, memberships, sessions projection, remotes metadata, operations,
  audit ledger.
- D1 repository adapters (not domain logic).
- KV preview-index adapter, R2 logs/artifacts adapter, Artifacts binding adapter shell, Secrets Store
  reference adapter.
- Deterministic resource provisioning/teardown scripts using `cf`; no Terraform unless documented
  gap is approved.
- Local outputs and migration helper wiring per root `AGENTS.md`.
- Observability binding/config enabled.

**Acceptance:** Worker integration test applies D1 migrations; adapters round-trip fixtures; deploy
and teardown dry-run/idempotence tests pass. No session agent/container code.

**Parallelism:** P1 parallel. Coordinate only on port interface shapes.

---

### P3 — Access, API middleware, project service

**Depends on:** P1, P2

**Owns:** Access JWT middleware, authorization, Hono route layer for project/session control-plane
operations, composition root.

**Requirements:** FR-AUTH-010…090; FR-PROJ-010…060 (except Artifacts implementation delegated P4);
FR-SESS-010/080/090; NFR-SEC-040.

**Deliverables:**

- Toolkit Access validation wired against known app/preview audiences.
- Shared access policy definition used by local Vite plugin and deployment reconciliation.
- Identity/membership authorization middleware; no user input selects identity.
- RFC 9457 mapping and request correlation middleware.
- Project CRUD/import orchestration over domain ports.
- Session create/stop/archive HTTP contracts from document 10.

**Acceptance:** Workers-runtime tests cover missing JWT, wrong audience, membership denial,
bypass-only public routes, and idempotent project/session creation. All endpoints return specified
problem types.

**Parallelism:** P4/P5 can use interfaces while P3 works; integration occurs after each lands.

---

### P4 — Artifacts workspace and git adapter

**Depends on:** P1, P2

**Owns:** Artifacts project/session branch operations, clone/commit/internal push, diff service,
external remote metadata validation.

**Requirements:** FR-GIT-010…050, FR-GIT-100 boundary definitions, FR-PROJ-010/015/020, NFR-SEC-010.

**Deliverables:**

- Artifacts adapter creates/imports/forks/gets/deletes repositories through Worker binding.
- Short-lived repo-token minting, header-based git invocation design; no token remote URLs.
- Session branch creation/idempotence and commit trailer policy.
- Git status/diff data adapters; large-output R2 handoff.
- Project toolchain detection service (package manager/lockfile/framework/dev port).
- Fixtures/fakes that make other packages independent of real Artifacts beta availability.

**Acceptance:** Tests demonstrate repo/branch isolation, exact ref validation, header form avoiding
`.git/config` credential, and agent cannot choose external remote. Document any API-beta mismatch.

**Parallelism:** P5 may initially use a fake git port.

---

### P5 — SessionDO and agent runtime

**Depends on:** P1; needs P2 interfaces, can start with fakes

**Owns:** `SessionDO`, Think harness, tool implementations, event stream/replay, snapshot/restore,
container/agent lifecycle.

**Requirements:** FR-SESS-020…070; FR-AGENT-010…110; FR-OPS-010…080; FR-TERM-050/060;
NFR-REL-010/020/030; NFR-COST-010/020.

**Deliverables:**

- Durable Object configured with direct Container API and `durable_object` scheduling policy.
- Constructor re-establishes inactivity timeout when container is already running.
- Alarm-based active-work keepalive.
- Think agent, versioned system prompt, tools and lifecycle/approval hooks.
- Event sequence storage/replay and WebSocket session endpoint.
- Snapshot persistence and hard-fail restore behaviour.
- Structured logging/tracing spans/usage ledger.

**Acceptance:** Integration tests for disconnect/reconnect, eviction/deploy recovery seam, snapshot
restore/missing snapshot, tool audit, budget refusal, no secrets in tool result/event. Container
smoke tests when Docker available.

**Parallelism:** P8 frontend can mock the event protocol before P5 lands.

---

### P6 — Frontend application shell and project screens

**Depends on:** P0; contract document 10

**Owns:** App layout/theme/accessibility shell, project list/create/overview/settings UI and typed
same-origin HTTP client.

**Requirements:** UI aspects of FR-PROJ-010…060, NFR-A11Y-010, NFR-DX-010.

**Deliverables:**

- Public landing and protected layout.
- Project list and creation wizard.
- Toolchain detection/review UI and resource/budget selection.
- Project overview, session cards, merge-queue placeholder, remote/publish settings screens.
- HTTP client with problem-details handling.

**Acceptance:** RTL tests verify accessible project creation flow, validation and errors, no direct
binding imports from client code.

**Parallelism:** P6 and P8 may proceed independently; align shared styles/layout tokens.

---

### P7 — Workspace/editor UI

**Depends on:** P1 contract, P6 shell

**Owns:** File tree, Monaco loader/editor, buffer conflict UX, diff UI.

**Requirements:** FR-WS-010…080; UI half of FR-GIT-050; NFR-PERF-050; NFR-A11Y-010.

**Deliverables:**

- Lazy tree and Monaco dynamic loading.
- Content-hash optimistic saving and conflict resolver.
- External-change handling; agent never clobbers dirty buffer.
- Per-file git status and unified diff views.

**Acceptance:** RTL tests named FR-WS-040 etc.; bundle/lazy-load test or inspection proves Monaco
is not on the initial route chunk.

---

### P8 — Session chat UI and event client

**Depends on:** P1 contract, P6 shell; integrates P5 later

**Owns:** `@cloudflare/ai-chat` integration, event WebSocket/reconnect state, transcript/tool cards,
approvals/background tray/cost state.

**Requirements:** FR-SESS-030/040/050; FR-AGENT-060/090/100; NFR-A11Y-020; NFR-PERF-030.

**Deliverables:**

- Ordered event client with state snapshot/replay/gap recovery.
- Transcript and streamed assistant rendering.
- Tool cards, safe output/log links, approval UI, background progress/cancel.
- Status/cost/header connection controls.

**Acceptance:** Mock WebSocket RTL tests cover duplicate/gap/reconnect, approval exactly once,
live-region throttling, terminal status states.

---

### P9 — Terminal and preview service/UI

**Depends on:** P5 and P7/P8 contracts; P2 preview DNS/KV support

**Owns:** xterm/tmux transport, dev-server process manager, Worker preview proxy, preview UI.

**Requirements:** all FR-TERM; all FR-PREV; NFR-SEC-030; NFR-PERF-040.

**Deliverables:**

- tmux-in-container Docker additions and raw terminal WebSocket transport.
- Resize protocol frozen with frontend.
- Background server start/stop/readiness/log-tail manager.
- Preview hostname proxy preserving HMR WebSockets and stripping control-plane credentials.
- Separate-origin iframe UI and Access policy reconciliation.

**Acceptance:** Container integration test reconnects terminal to same tmux scrollback; preview test
reaches `0.0.0.0` server, fails localhost-only cleanly, and forwards WebSocket upgrade. Security test
proves preview cookie/control route isolation.

---

### P10 — Merge queue, publisher, CI workflow

**Depends on:** P3/P4/P5/P2

**Owns:** ProjectDO merge serialization, ephemeral publisher HTTPS/SSH, Artifacts event CI.

**Requirements:** FR-GIT-060…140; FR-OPS-090/100; NFR-SEC-010/020/050; NFR-REL-030.

**Deliverables:**

- ProjectDO durable merge queue and conflict reporting.
- Ephemeral HTTPS publisher with outbound header injection.
- Ephemeral SSH publisher with Secrets Store key, pinned known hosts, strict checking, guaranteed
destroy.
- Artifacts push event → debounced CI Workflow, `@cloudflare/ci` runners, R2 logs.
- Admin running-container/operation view API.

**Acceptance:** Concurrency test proves one merge at a time; fixture conflict has no base mutation;
HTTPS/SSH publish test asserts no key/token reaches a session container; host key mismatch rejects.

---

### P11 — Security, accessibility, architecture review

**Depends on:** all feature packages

**Owns:** Cross-cutting review/remediation, not a separate feature implementation.

**Requirements:** Entire [05-security.md](./05-security.md) checklist, NFR-A11Y-010/020,
NFR-SEC-010…050.

**Deliverables:**

- Run static secret/Wrangler/SSH checks.
- Review every outbound handler and Access route.
- Run accessibility reviewer/code/security reviews.
- Add missing requirement-ID tests.
- Validate tier dependency direction and JSDoc completeness.

**Acceptance:** Security checklist fully checked with test references; no high-severity findings;
architecture review documents no tier violations.

---

### P12 — Documentation and release readiness

**Depends on:** all packages

**Owns:** `codeflare/README.md`, operator runbook, user quickstart, final test/deploy/teardown rehearsal.

**Requirements:** root Definition of Done, [00-product.md §8](./00-product.md#8-what-done-looks-like).

**Deliverables:**

- Prerequisites: Workers Paid, Artifacts beta, Zero Trust, configured domain, Docker for local
  container development, root `.env` permissions.
- Exact local/deploy/teardown commands.
- Security/data-flow disclosure and trade-offs: beta products, snapshot expiry, model providers,
  Artifacts as working store.
- Screenshots/architecture diagram as useful.
- Clean-account deploy then teardown proof.

**Acceptance:** A cold reviewer follows README from fresh clone. Root `pnpm check`, `pnpm test`,
Codeflare `pnpm start`, deploy, and teardown pass.

## 4. Suggested swarm sequence

1. Assign P0 to a lead. It produces compileable ground and freezes configuration conventions.
2. In parallel after P0: P1 (domain) and P2 (infrastructure).
3. After interfaces settle: P3, P4, P5, P6 in parallel.
4. P7 and P8 start against contract mocks; P9 begins once P5 container abstraction is available.
5. P10 follows P3/P4/P5; it owns high-risk publishing and merge work.
6. P11 runs review continuously but blocks final merge/release; P12 follows feature integration.

Do not ask one agent to implement both the security-sensitive outbound gateway and a feature that
benefits from bypassing it. Separation of review responsibility is intentional.
