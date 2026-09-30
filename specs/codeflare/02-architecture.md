# 02 — Architecture

## 1. Shape of the system

Codeflare is one Worker with several Durable Object classes, a container application under the
`durable_object` scheduling policy, and a set of storage bindings. There is no second service and
no control plane outside Cloudflare.

```text
                        ┌─────────────────────────────────────────────┐
  browser               │            Cloudflare Access                │
  ┌──────────────┐      │  codeflare.example.com   *.preview.example.com  │
  │ vinext UI    │──────┤  (team policy)       (team policy)          │
  │ chat/editor  │      └───────────────────┬─────────────────────────┘
  │ term/preview │                          │
  └──────┬───────┘                          │
         │ HTTPS + WebSocket                │
         ▼                                  ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │                      Codeflare Worker (vinext)                       │
  │  ┌────────────┐ ┌────────────┐ ┌─────────────┐ ┌──────────────┐  │
  │  │ app router │ │ API tier   │ │ preview     │ │ outbound     │  │
  │  │ + RSC      │ │ (Hono)     │ │ router      │ │ entrypoints  │  │
  │  └────────────┘ └─────┬──────┘ └──────┬──────┘ └──────┬───────┘  │
  └───────────────────────┼───────────────┼───────────────┼──────────┘
                          │               │               │
        ┌─────────────────┼───────────────┘               │ credential
        │                 │                               │ injection
        ▼                 ▼                               ▼
 ┌─────────────┐   ┌──────────────────────────┐   ┌─────────────────┐
 │ ProjectDO   │   │ SessionDO  (per session) │   │ AI Gateway      │
 │ merge queue │   │  Think agent harness     │   │ github.com      │
 │ membership  │   │  SQLite: msgs, state     │   │ gitlab.com      │
 │ registry    │   │  alarm: keepalive        │   │ *.artifacts...  │
 └──────┬──────┘   │  ctx.container ──────────┼──▶│                 │
        │          └──────────┬───────────────┘   └─────────────────┘
        │                     │
        ▼                     ▼
 ┌─────────────┐    ┌────────────────────────────┐
 │ D1          │    │ Container (microVM)        │
 │ projects    │    │  node, pnpm, git, tmux     │
 │ sessions    │    │  /workspace = git worktree │
 │ members     │    │  dev server on :PORT       │
 │ audit       │    │  snapshot ⇄ DO storage     │
 └─────────────┘    └────────────────────────────┘
        │
        ▼
 ┌─────────────┐  ┌─────────────┐  ┌───────────────────┐
 │ Artifacts   │  │ R2          │  │ KV                │
 │ git store   │  │ logs, blobs │  │ cache, rate limit │
 └─────────────┘  └─────────────┘  └───────────────────┘
```

## 2. The four tiers

The root `AGENTS.md` mandates `UI → API → application/domain → infrastructure` with dependencies
pointing one way. Codeflare maps onto that as follows. **A violation of this mapping is a review
blocker**, not a style preference.

### Tier 1 — UI (`src/ui/`, `app/`)

vinext App Router pages and React components. Server components by default; `'use client'` only
where browser state, effects, events, or browser APIs are genuinely needed — which is true for the
chat stream, Monaco, xterm.js, and the preview frame.

The UI talks to its own backend over HTTP and WebSocket. It never imports a storage binding, never
imports `cloudflare:workers`, and never constructs a repository.

### Tier 2 — API (`src/api/`)

Hono application mounted from vinext route handlers. Responsibilities, and nothing else:

- HTTP routing and method dispatch.
- Access JWT validation middleware and identity extraction.
- Request size limits, rate limiting, and content negotiation.
- Request body parsing into domain input types.
- Response shaping, including RFC 9457 problem responses via the toolkit's error handler.
- WebSocket upgrade handling and hand-off to the correct Durable Object.

A route handler reads as a description of the API surface. It does not contain business rules and
it does not construct a repository.

### Tier 3 — Application / domain (`src/domain/`)

Use cases and rules. `ProjectService`, `SessionService`, `GitService`, `PublishService`,
`BudgetService`. Validation lives here so every transport enforces the same rules.

This tier depends on **ports** — TypeScript interfaces — never on a concrete Cloudflare product:

```ts
export interface ProjectRepository { /* … */ }
export interface SessionRepository { /* … */ }
export interface GitRepository { /* … */ }
export interface SandboxPort { /* … */ }
export interface ModelGatewayPort { /* … */ }
export interface SecretsPort { /* … */ }
```

### Tier 4 — Infrastructure (`src/infra/`)

The adapters. `D1ProjectRepository`, `ArtifactsGitRepository`, `ContainerSandboxAdapter`,
`AiGatewayAdapter`, `SecretsStoreAdapter`. Plus the Durable Object classes, which are
infrastructure that hosts domain services rather than domain objects themselves.

### Composition

Tiers are composed in exactly one place — the Worker entry point and the Durable Object
constructors — and the composed service is injected into request handling. This is the rule that
keeps the seams visible in a small codebase.

## 3. Durable Object topology

Three classes. Getting these boundaries right is the single most consequential structural decision
in the system.

### `SessionDO` — one per session

The heart of Codeflare. It is a `Think` subclass (the Agents SDK harness) with a container attached.

Owns:

- The conversation transcript and turn state, in its SQLite storage.
- The container lifecycle: which image, which instance size, when to start, when to snapshot, when
  to stop.
- The snapshot handle.
- WebSocket connections from clients: chat, terminal, file-tree events.
- An alarm that keeps the container alive while work is outstanding.
- Outbound interception configuration for its own container.

Does **not** own: project membership, the merge queue, or anything shared between sessions. A
`SessionDO` that needs a cross-session decision asks `ProjectDO`.

Why a Durable Object: a container is bound to a Durable Object under the `durable_object`
scheduling policy, and the session needs strongly consistent single-writer state. This is the
textbook case.

### `ProjectDO` — one per project

The coordinator. Owns:

- The merge queue. Serialised integration of session branches into the base branch. This is the
  reason it exists: FR-GIT-060 requires that two sessions can never merge concurrently, and a
  single-threaded Durable Object gives that for free.
- The live-session registry for the project, so the UI can list sessions without scanning D1.
- Fan-out of project-level events to connected clients.

Does **not** own the authoritative project record — that is D1, so it can be queried relationally
and survive a namespace change.

### `PreviewRouterDO` — optional, one per project

Maps preview hostname → session. Only needed if hostname-to-session resolution becomes too
expensive for a KV lookup. **Start with KV.** Introduce this class only if measurement demands it,
and record the measurement.

## 4. Storage: what goes where, and why

Choosing storage by the guarantee needed, and documenting the trade-off, is a root `AGENTS.md`
requirement. Here is the full accounting.

| Store                    | Holds                                                                       | Guarantee needed                        | Trade-off accepted                                                              |
| ------------------------ | --------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| **D1**                   | Projects, sessions, members, remotes, audit log, budget ledger              | Relational queries, constraints, joins  | Not strongly consistent with DO state; DO is authoritative for live state, D1 for the record. |
| **Durable Object SQLite** | Transcript, turn state, container handle, snapshot ID, per-session counters | Strong consistency, single writer       | Only reachable through that one object; not queryable across sessions.          |
| **Artifacts**            | All git history, every branch, every commit                                 | Real git semantics, per-repo isolation  | Closed beta; 10 GB per repo; 1 TB per account.                                   |
| **Container filesystem** | The working tree, `node_modules`, build output                              | POSIX filesystem, real tooling          | Ephemeral. Gone when the instance stops unless snapshotted.                      |
| **Container snapshot**   | Point-in-time full filesystem                                               | Fast warm restart                       | Immutable, image-pinned, 20 GB max, 30-day TTL refreshed on restore.             |
| **R2**                   | Archived logs, large artifacts, exported bundles                            | Cheap durable blobs                     | Eventually consistent listings.                                                  |
| **KV**                   | Preview hostname → session map, rate-limit counters, config cache           | Read-heavy, low latency, global         | Eventually consistent. Never authoritative for authorization.                    |
| **Secrets Store**        | GitHub/GitLab tokens, the SSH private key, AI Gateway token                 | Never in code, never in a container     | Requires a Worker round trip to use.                                             |

**The consistency rule.** Live session state is authoritative in the `SessionDO`. D1 is a
projection written on state transitions. A read that must be correct right now goes to the DO; a
read that lists or aggregates goes to D1. Never authorize against KV.

## 5. Request paths

### Control plane

```text
Browser → Access (edge) → Worker fetch → vinext router → Hono API
  → Access JWT middleware (validate signature + aud + identity)
  → authorization (project membership, in the domain tier)
  → domain service → port → adapter → D1 / Artifacts / DO stub
  → RFC 9457 on failure, typed JSON on success
```

### Session WebSocket

```text
Browser → Access → Worker → resolve sessionId → authorize identity against session owner
  → env.SESSION.getByName(sessionKey).fetch(upgradeRequest)
  → SessionDO accepts the socket, sends a full state snapshot, then streams events
```

Note the WebSocket limitation: Worker-level Access policies do not support WebSocket upgrades. The
Codeflare application hostname must therefore be protected by a **hostname-based** Access application,
not by the "protect this Worker" toggle. This is called out again in
[04-platform-notes.md](./04-platform-notes.md) and [05-security.md](./05-security.md) because
getting it wrong produces a 403 that is hard to diagnose.

### Preview

```text
Browser → https://<session>.preview.example.com/...
  → Access (wildcard hostname application, team policy)
  → Worker route *.preview.example.com/*
  → parse label, validate as a DNS label, map to sessionId via KV
  → env.SESSION.getByName(sessionKey).fetch(rewritten http: request)
  → SessionDO ensures the dev server is up
  → ctx.container.getTcpPort(port).fetch(request)   // supports WebSocket upgrade
```

The scheme must be rewritten to `http:` before calling `getTcpPort().fetch()`, which does not
accept `https:` URLs.

### Outbound from a container

```text
container process (git / npm / agent CLI) → port 80 or 443
  → intercepted (enableInternet: false, no direct egress)
  → Worker outbound entrypoint, per hostname
  → allowlist check on hostname, method, and path
  → inject credential from Secrets Store
  → fetch upstream
```

This is the mechanism behind NFR-SEC-010. It is a structural property, not a policy that can be
turned off.

## 6. Container design

One image per project class, built from a Dockerfile in the repository and referenced as a named
image under the `durable_object` scheduling policy.

Base image contents:

- Node.js 24 on Debian Trixie slim.
- `pnpm` (matching the repository standard), plus `npm` and `yarn` for imported projects that need
  them.
- `git`, `openssh-client`, `ca-certificates`, `ripgrep`, `tmux`, `curl`, `jq`.
- The coding-agent CLI, at a pinned version, if the session uses a CLI-based agent rather than an
  in-DO harness.
- `sandbox-shim`, copied from the `cloudflare/sandbox` image at the tag matching the installed
  `@cloudflare/sandbox` version.

Rules:

- `CMD ["sleep", "infinity"]`. The main process must not exit, because when it exits the instance
  stops and every `exec()` process dies with it.
- Everything the agent needs is installed **in the image**. The container cannot download packages
  at runtime except through an explicitly allowlisted registry host.
- `/workspace` is the working tree.
- Instance size is chosen at `start()` from a bounded set: `standard-1` for light editing,
  `standard-2` as the default for a web project with a dev server, `standard-3` when the project
  declares a heavy build. Never unbounded (NFR-COST-020).

## 7. Frontend architecture

vinext App Router, following the `vinext-demos/AGENTS.md` conventions: server components by
default, the Cloudflare Vite plugin, the toolkit's Access local-development plugin registered
**before** `cloudflare()`, and `cloudflare:workers` imported only from server code.

Four panes, each an independent client island so one stalling does not block the others:

| Pane     | Library                    | Transport                       | Client state                            |
| -------- | -------------------------- | ------------------------------- | --------------------------------------- |
| Chat     | `@cloudflare/ai-chat/react` | WebSocket to `SessionDO`        | Message list, streaming turn, approvals |
| Files    | Monaco                     | HTTP for content, WS for events | Open buffers, dirty flags, tree         |
| Terminal | xterm.js                   | WebSocket to `SessionDO`        | Scrollback (server-side, in tmux)       |
| Preview  | `<iframe>`                 | Direct to the preview origin    | Status, log tail                        |

Monaco and xterm.js are heavy. Both are dynamically imported and rendered only when their pane is
first opened.

**The preview is an `<iframe>` pointing at a different origin.** It is never same-origin with the
Codeflare app. This follows from principle 7 in [00-product.md](./00-product.md) and NFR-SEC-030.

## 8. Cap'n Web: where it is used, and where it is not

Cap'n Web is an object-capability RPC system that works over WebSocket and HTTP batch, with promise
pipelining and pass-by-reference. It is a good fit in exactly two places.

**Use it for the browser ⇄ `SessionDO` session API.** A session client makes many dependent calls —
open a file, read it, subscribe to its changes — and pipelining collapses those round trips.
Capability passing also models the authorization cleanly: the client receives a stub scoped to one
session and physically cannot address another.

**Use it for `computerd`-style container ⇄ Worker channels** if a package needs a structured
bidirectional channel to a container-side daemon.

**Do not use it** for the public REST surface. Project CRUD is better as plain HTTP with RFC 9457
errors: it is cacheable, inspectable, curl-able, and it is what the root `AGENTS.md` error handling
assumes. Do not use it for the terminal either — that is a raw byte stream and Cap'n Web adds
nothing.

## 9. Directory layout

```text
codeflare/
├── AGENTS.md                      # family rules, supplements the root file
├── README.md                      # prerequisites, commands, trade-offs
├── package.json                   # the five required scripts + test
├── cloudflare.config.ts           # typed cf configuration, the single source of truth
├── vite.config.ts                 # cloudflareAccessPlugin → vinext → cloudflare
├── oxlint.config.ts               # extends ../oxlint.base.ts, adds react + typescript
├── tsconfig.json
├── container/
│   └── Dockerfile                 # the session image
├── app/                           # vinext App Router
│   ├── page.tsx                   # public landing
│   ├── projects/…
│   ├── sessions/[id]/…
│   └── api/[[...route]]/route.ts  # single adapter into the Hono app
├── src/
│   ├── ui/                        # components, hooks, client-side HTTP
│   ├── api/                       # Hono app, middleware, routes
│   ├── domain/                    # services, entities, validation, ports
│   ├── infra/                     # adapters, Durable Objects, outbound entrypoints
│   ├── access-policies.ts         # the one shared path-policy array
│   └── worker.ts                  # composition root
├── migrations/                    # D1 migrations
├── test/
│   ├── unit/                      # domain and validation
│   ├── ui/                        # DOM, React Testing Library
│   └── integration/               # @cloudflare/vitest-plugin, Workers runtime
└── infra/                         # only if Terraform proves necessary; see below
```

## 10. Lifecycle ownership

Per root `AGENTS.md`, pick the least complex lifecycle owner that provides start, deploy, and
teardown. Codeflare's assessment:

| Resource                          | Owner                        | Rationale                                                                 |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| Worker, DO namespaces, containers | `cf deploy`                  | The framework pipeline creates and removes these completely.              |
| D1, KV, R2                        | `cf` resource commands       | Created in deploy, deleted in teardown, both idempotent.                  |
| Artifacts namespace and repos     | Application, at runtime      | Repos are created per project by the running application; teardown reaps. |
| Access applications and policies  | `cf-access-controls`         | Root `AGENTS.md` requires this for non-Terraform demos.                   |
| Preview wildcard DNS record       | `cf` DNS commands            | One record; scriptable and idempotent.                                    |
| Secrets                           | `cf` secret commands         | Never in a config file.                                                   |

**Terraform is not required for Codeflare** and should not be introduced unless a package finds a
resource that `cf` cannot create *and* delete. If that happens, record it in
[14-risks.md](./14-risks.md) before adding Terraform, because adding it changes the family rules.
