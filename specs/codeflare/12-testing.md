# 12 — Testing

Tests must pass offline and use no live infrastructure. Test the tier where the behaviour belongs;
do not paper over domain failures with browser tests.

## 1. Test matrix

| Layer                    | Location              | Environment                         | Primary subjects                                             |
| ------------------------ | --------------------- | ----------------------------------- | ------------------------------------------------------------ |
| Domain unit              | `test/unit/`          | Node/Vitest                         | Validation, transitions, budget, policy, ports via fakes.    |
| UI DOM                   | `test/ui/`            | jsdom/Vitest + RTL                  | Visible behaviour, accessibility, reconnect/buffer logic.    |
| Worker integration       | `test/integration/`   | `@cloudflare/vitest-plugin`         | DO, D1 migrations, bindings, Access, API, outbound routing. |
| Container integration    | `test/integration/`   | Local `cf dev` / Docker as supported | Clone, exec, tmux, preview, snapshot; tagged/optional if platform limitation. |
| E2E                      | future `test/e2e/`    | Browser + deployed preview/staging  | Actual terminal/reconnect/HMR/access journeys.               |

Use `@cloudflare/vitest-plugin` (not its deprecated former name). D1 integration tests use
`readD1Migrations()` from the plugin and `applyD1Migrations()` from `cloudflare:test`.

## 2. Requirement coverage

The test name contains the requirement ID. Examples:

```ts
it('FR-AUTH-020 rejects an Access token for a different application audience', async () => { … });
it('FR-OPS-030 does not start an empty workspace after snapshot restore failure', async () => { … });
it('NFR-SEC-010 leaves no credential in git config or process environment', async () => { … });
```

The package owner maintains a simple coverage table in test comments or `codeflare/README.md` mapping
requirements to test files. Do not introduce a heavyweight custom test framework merely for this;
the identifiers in test names are searchable.

## 3. Domain tests

Use fakes of ports. No Worker runtime, no D1, no fetch.

### Required cases

| Requirement / concern      | Tests |
| -------------------------- | ----- |
| Project/session validation | Invalid slug, path traversal, malformed remote URL, remote URL with inline credential, invalid branch/ref. |
| State machine              | Every valid transition; every invalid transition rejected; sleeping requires snapshot; terminal cannot resume. |
| Budget                     | Refuse over-budget before model call; exact boundary; turn count/running time/model spend independently. |
| Ownership                  | Different Access user cannot act on session; admin can where policy allows. |
| Egress policy              | Only declared host/method/path pairs accepted; `git-receive-pack` rejected from session mode. |
| Approval                   | Hash mismatch rejected; expired request rejected; exactly-once decision. |
| Merge queue                | One active merge only; conflict outcome preserves branches; stale target update rejected. |
| Publish                    | Only configured remote/ref; SSH requires pinned known hosts; agent identity cannot invoke it. |

## 4. UI tests

Use React Testing Library and `@testing-library/user-event`. Test visible behaviour and accessible
controls, never component instance state.

### Required cases

- **FR-SESS-050:** reconnect applies a snapshot and ordered subsequent events; duplicate event is
  ignored; a gap triggers snapshot refresh.
- **FR-WS-040:** external agent change updates a clean editor buffer but presents a choice for a
  dirty buffer.
- **FR-TERM-030:** terminal component reconnects with same named terminal and requests existing
  scrollback, not a new name.
- **FR-PREV-020 / NFR-SEC-030:** preview iframe source is a preview hostname, never the app origin;
  iframe has required sandbox/referrer settings.
- **FR-AGENT-100:** approval card exposes exact operation and keyboard-reachable approve/reject.
- **NFR-A11Y-010:** pane landmarks/names, keyboard controls, focus after modal/open/close,
  colour-independent status indication.
- **NFR-A11Y-020:** stream update announcements are throttled/coalesced.

## 5. Workers runtime integration tests

Use the real Workers runtime bindings through the Vitest plugin. These are the most valuable tests
for Codeflare because they catch Durable Object and request-boundary errors that Node fakes cannot.

### Database setup

```ts
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { applyD1Migrations, env } from 'cloudflare:test';

beforeAll(async () => {
  const migrations = await readD1Migrations('../../migrations');
  await applyD1Migrations(env.DB, migrations);
});
```

Adjust path only as needed. Never test migrations against a live D1 database.

### Access tests

Use toolkit helpers for signing development JWTs.

| ID          | Test                                                                                 |
| ----------- | ------------------------------------------------------------------------------------ |
| FR-AUTH-010 | No JWT returns authentication problem.                                               |
| FR-AUTH-020 | Valid signature but wrong `aud` returns forbidden.                                  |
| FR-AUTH-030 | Client-supplied `userId` cannot alter effective identity.                           |
| FR-AUTH-040 | Member/non-member/admin matrix for each protected endpoint.                         |
| FR-AUTH-060 | Local Access plugin header leads through the same middleware path.                  |
| FR-AUTH-080 | Health/landing bypass; a similar non-public path does not.                          |

### Session and Durable Object tests

- Create session → state becomes `creating` → fake clone completes → `ready`.
- Submit same message idempotency key twice → one durable turn/message.
- Open two WebSocket clients → both receive same ordered events.
- Disconnect one client while a fake/controlled turn continues → reconnect and replay.
- Force/trigger DO eviction with `cloudflare:test` helper → timeout is re-established and durable
  transcript state remains.
- Snapshot handle persists; restoration passes handle to container adapter.
- Missing snapshot transitions to `failed`; assert adapter is **not** asked to start base image.
- ProjectDO concurrent merge requests → only one adapter `merge()` invocation active.

### Outbound-security tests

These are not optional; they enforce the central invariant.

- Container-mode adapter starts with `enableInternet: false`.
- Unknown host, wrong method, wrong path return 403.
- Git read operation permits only selected repo `git-upload-pack` endpoints.
- Session-container `git-receive-pack` is rejected.
- Credential injection occurs only for HTTPS; `http:` rejects before secret lookup.
- Response/log objects redact `Authorization`, token-like values, and SSH private-key material.

## 6. Container integration tests

Run these locally when Docker is available. They can be a distinct test command with a documented
skip only when Docker is unavailable in an offline CI environment, but the release gate runs them.

| Scenario                    | Assertion                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| Base image                  | `git`, `tmux`, Node, package manager, and `rg` exist; main process remains running.              |
| Shell                       | `exec()` works, explicit shell handles pipe, timeout kills process group, output cap applies.    |
| Clone                       | Clone via Authorization header succeeds; `.git/config` contains a credential-free origin URL.    |
| Agent edit                  | File edit/commit/push appears in Artifacts fake/local implementation.                             |
| Terminal                    | tmux process stays after WebSocket disconnect; reconnect sees prior scrollback/output.            |
| Preview                     | Vite-compatible server listening on `0.0.0.0` is reachable via port proxy; localhost-only server fails with clear status. |
| HMR websocket               | Upgrade forwards through preview proxy.                                                           |
| Snapshot                    | File survives stop/restore; running process does not, and dev-server restarts explicitly.         |
| Egress                      | Non-allowlisted host cannot connect.                                                              |

## 7. End-to-end acceptance journeys

M3 end-to-end suite, running against an isolated staging account/project with non-production
credentials:

1. **One-session journey:** import a fixture project; task adds a component; inspect streamed tool
   calls; open preview; archive; reopen and verify restored source.
2. **Reconnect journey:** start a long controlled turn; close tab/connection; reconnect; observe
   continued progress and ordered transcript.
3. **Swarm journey:** create three sessions against a fixture; each edits distinct files; request
   merge; assert serial merges and clean final branch.
4. **Conflict journey:** two sessions edit same line; merge first; second becomes conflicted;
   conflict files/hunks are visible and base branch untouched.
5. **HTTPS publish:** publish fixture branch to a test GitHub/GitLab repo; ensure target branch
   exists and no token appears in session filesystem/logs.
6. **SSH publish:** same with a throwaway deploy key and pinned known host; reject an altered host
   key fixture.
7. **Preview security:** preview cannot read application cookie; requests to a management route from
   preview origin fail; WebSocket HMR connects.
8. **Budget journey:** low budget causes an attempted next turn to suspend with clear UI.

No production source, secret, or customer external repository appears in E2E fixtures.

## 8. Performance testing

Measure against NFR targets, do not guess.

- Warm `SessionDO` chat admission/first stream byte: p50/p95.
- Snapshot restore to interactive: p50/p95, separated by project size bucket.
- File open under 256 KiB: p50/p95.
- Terminal input/echo using an instrumented echo process: p50/p95.
- Concurrent session load: at least 10 sessions with independent containers; assert no event/branch
  cross-talk and track start failures.

Store benchmark results in an ignored artifact or CI output, not as hand-maintained claims in the
README. Regressions over 20% fail a performance review.

## 9. Static/security checks

In addition to Oxlint/typecheck:

- Search committed files for common token/private-key patterns; fail on a real match.
- Assert no `wrangler` dependency, command, or config appears.
- Assert no `StrictHostKeyChecking=no` appears.
- Assert all exported symbols have JSDoc (lint rule or AST check).
- Assert public API handlers use RFC 9457 error middleware.
- Assert production build output lacks development Access-bypass code.

Security scanners (Semgrep/CodeQL) are run in review CI where available, plus manual review of
outbound handlers, Access validation, and all secret boundaries.
