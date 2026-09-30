# 14 — Risks, decisions to validate, and open questions

This is not a backlog disguised as a risk list. Each item has an owner and a validation action. No
agent should quietly make an irreversible choice in one of these areas.

| ID | Risk / unknown | Impact | Mitigation / validation | Owner / decision gate |
| -- | -------------- | ------ | ----------------------- | --------------------- |
| R1 | `cf` CLI is beta; much product documentation still shows Wrangler configuration/commands. | Build/deploy scripts may drift or a package may violate the no-Wrangler rule. | Pin `cf`; use `cf cli search` for API operation discovery; translate examples into `cloudflare.config.ts`; add static CI ban on Wrangler. | P0/P2; block deploy wiring. |
| R2 | Containers `durable_object` scheduling and snapshots are public beta. | API/behaviour change could affect core session persistence. | Encapsulate direct Container API behind `SandboxPort`; integration test snapshot/restore; use Artifacts branch as durable source fallback. | P5; block M1 recovery claim. |
| R3 | Artifacts is closed beta. | API availability/limits/support may change; access may be constrained. | Build an `ArtifactsGitRepository` adapter with in-memory/local fake; retain a documented fallback to external git as working store only if beta availability ends. | P4; validate before M1. |
| R4 | SSH publishing needs a network path that session containers explicitly do not have. | Incorrect solution could put SSH keys in session sandbox or open arbitrary egress. | Dedicated ephemeral publisher; validate supported SSH egress/Worker connection path against current docs; security review before implementation. | P10; **do not ship SSH publishing until validated**. |
| R5 | Snapshot includes `node_modules` and has 20 GB/30-day limits. | Large project snapshot may fail or be costly/slow. | Measure fixture sizes; source truth is always Artifacts; design explicit clone+install recovery; do not silently omit data. | P5/P11; validate pre-M3. |
| R6 | Container runtime costs are material: `standard-2` provisions 6 GiB even when idle. | Runaway cost or unsustainable demo. | Default idle sleep; budgets; visible usage; enforce bounded instance sizes; test alarm/timeout logic. | P5/P11. |
| R7 | Worker-level Access cannot do WebSockets. | Chat/terminal/HMR 403 if wrong Access app type used. | Hostname-based Access applications only; integration/E2E WebSocket Access test. | P3/P9; hard gate. |
| R8 | A preview executes untrusted browser JS. | Cookie/API exfiltration if same-origin or header stripping is wrong. | Separate preview zone; host-only app cookie; proxy strips credentials; security E2E. | P9/P11; hard gate. |
| R9 | `@cloudflare/computer` is explicitly preview-only and FUSE VFS slows heavy I/O. | Tempting abstraction may make installs slow and bind production to unstable API. | Do not use for Codeflare core. Re-evaluate only for optional lightweight agent file tools. | Architecture lead; closed for M1–M3. |
| R10 | vinext 1.0 has compatibility gaps for newer Next App Router/cache/native-module behaviours. | Imported Next web apps may not preview/build successfully. | Codeflare only needs to run user's declared dev command, not convert app. Offer vinext as the Codeflare UI framework; document project-preview compatibility and show logs. | P6/P9; not a blocker. |
| R11 | External provider API differences/private imports. | GitHub/GitLab HTTPS auth scopes and GitLab variants may differ. | Provider adapter interface; fixtures for both; remote setup UI requires explicit capability test before save. | P4/P10. |
| R12 | Long-running `pnpm install`/tests do not keep container alive themselves. | Work can be SIGTERM'd mid-command. | 60-second DO alarm while work/background process exists; integration test with controlled long process. | P5; hard gate. |
| R13 | `start()` returns before container readiness; dev servers may bind localhost. | Flaky commands/previews. | Explicit readiness poll, 30-second bound; detection forces `0.0.0.0`; integration tests. | P5/P9. |
| R14 | Artifacts guidance prefers a repo per agent/session, but Codeflare uses one repo plus branches per project. | Concurrent autonomous work could create a shared-repo hotspot. | ProjectDO serial merge queue; session branches isolated; measure push/merge rate; move to repo-per-session if scale demands it. | P4/P10; architectural trade-off accepted for v1. |
| R15 | Dynamic Workers/Browser Run/Agents SDK APIs evolve rapidly. | Optional agent features could break. | Isolate optional tools behind ports; do not include Browser Run in M1. | P5; post-M2. |
| R16 | Secrets Store integration/CLI lifecycle might need a resource not `cf` currently owns end-to-end. | Could force Terraform despite product preference. | Before adding Terraform, document exact missing create/delete operation here and obtain approval. | P2; hard process gate. |
| R17 | Cloudflare Access local plugin, vinext RSC build, and Cloudflare Vite ordering are sensitive. | Local auth differs from deployed. | Start from family canonical ordering; integration test local signed JWT path. | P0/P3. |
| R18 | Human concurrent editor + agent changes. | Data loss/clobbered worktree. | Hash-based optimistic writes; dirty-buffer conflict UI; no multi-human collaborative edit in v1. | P7; hard gate for editor. |
| R19 | User tasks can include prompt injection in repository content. | Agent may act outside intended scope. | System prompt treats repo content as data; least privilege tools/egress; human-only publish; approvals. Evaluate adversarial fixture. | P5/P11. |
| R20 | Preview custom domain/DNS teardown has eventual propagation. | A stale preview URL could exist briefly after archive. | Remove KV routing/auth immediately; DNS wildcard stays but unmapped hosts 404; test control plane denies archived mapping. | P9. |

## Accepted trade-offs

1. **One Artifacts repo with branches per project.** Artifacts recommends repo-per-agent when units
   are fully independent. Codeflare sessions intentionally need to merge into a common project branch,
   so branches plus a strongly consistent merge queue are the right v1 compromise.
2. **Snapshot is an optimisation, not source of truth.** A snapshot is tied to an image and expires;
   Artifacts git is the recovery anchor.
3. **No real-time multi-human file editing.** Hash conflicts are explicit rather than pretending a
   code editor can safely merge concurrent human/agent edits without a CRDT design.
4. **No auto-publish.** This costs a click but prevents the highest-impact prompt-injection outcome.
5. **No public previews.** Team Access adds friction but matches a coding environment holding
   private source and dev servers.
6. **No `@cloudflare/computer` core dependency.** It is innovative and relevant, but its own README
   labels it preview-only and unsuitable for production today.

## Questions deliberately deferred beyond M3

- Organisation-wide shared workspaces vs session isolation.
- PR/MR creation and review comments in GitHub/GitLab.
- Code review agent triggered by Artifacts push.
- Browser Run automatic UI verification.
- IDE extension / local checkout bridge.
- Organisation-owned model policies and BYOK UX.
- Per-seat/per-project cost chargeback.
- Custom container images supplied by project admins.
- Retention/legal hold/data residency configuration UI.
