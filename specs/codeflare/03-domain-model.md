# 03 — Domain model

This is the shared vocabulary. Every package uses these names. If you need a concept that is not
here, it probably belongs to an existing entity — check before adding one.

## 1. Entities

### `User`

Not stored as a row of truth. The authenticated identity from Cloudflare Access.

| Field   | Type                  | Notes                                                        |
| ------- | --------------------- | ------------------------------------------------------------ |
| `email` | `string`              | From the Access JWT. The stable identifier.                  |
| `sub`   | `string`              | Access subject claim.                                        |
| `role`  | `'member' \| 'admin'` | Derived from Access group membership, resolved per request.   |

**Invariant.** A `User` is only ever constructed from a validated Access JWT. There is no code path
that builds one from a request body, path parameter, or query string.

### `Project`

A unit of source. Backed by exactly one Artifacts repository.

| Field               | Type                 | Notes                                                       |
| ------------------- | -------------------- | ----------------------------------------------------------- |
| `id`                | `string`             | Server-generated. URL-safe, 16 chars.                        |
| `name`              | `string`             | Display name, 1–64 chars.                                    |
| `slug`              | `string`             | A valid DNS label. Used in hostnames and repo names.         |
| `artifactsRepo`     | `string`             | Repository name within the namespace.                        |
| `defaultBranch`     | `string`             | Usually `main`.                                              |
| `toolchain`         | `Toolchain`          | Detected, user-overridable. See below.                       |
| `containerImage`    | `string`             | Named image key from `cloudflare.config.ts`.                 |
| `instanceSize`      | `InstanceSize`       | `'standard-1' \| 'standard-2' \| 'standard-3'`.              |
| `remotes`           | `ExternalRemote[]`   | Configured publish targets.                                  |
| `budget`            | `Budget`             | Project-level ceiling.                                       |
| `createdBy`         | `string`             | Email of the creator.                                        |
| `createdAt`         | `string`             | ISO 8601.                                                    |

**Invariants.**
- `slug` matches `/^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/`. It becomes part of a hostname, so this
  is enforced at creation and never relaxed.
- `artifactsRepo` is unique within the namespace.
- `defaultBranch` is non-empty.

### `Toolchain`

| Field            | Type                                    | Example                    |
| ---------------- | --------------------------------------- | -------------------------- |
| `packageManager` | `'pnpm' \| 'npm' \| 'yarn' \| 'bun'`    | `'pnpm'`                   |
| `installCommand` | `string`                                | `'pnpm install --frozen-lockfile'` |
| `devCommand`     | `string`                                | `'pnpm dev --host 0.0.0.0'` |
| `devPort`        | `number`                                | `5173`                     |
| `testCommand`    | `string \| null`                        | `'pnpm test'`              |
| `buildCommand`   | `string \| null`                        | `'pnpm build'`             |

**Invariant, and it bites.** `devCommand` **must** cause the server to listen on `0.0.0.0`.
`getTcpPort().fetch()` cannot reach a server bound only to `127.0.0.1`, and most dev servers default
to localhost. Detection must add the appropriate flag, and validation must reject a `devCommand`
that is known to bind localhost-only without an override flag.

### `ExternalRemote`

A publish target.

| Field         | Type                          | Notes                                                    |
| ------------- | ----------------------------- | -------------------------------------------------------- |
| `id`          | `string`                      | Server-generated.                                         |
| `provider`    | `'github' \| 'gitlab'`        |                                                           |
| `protocol`    | `'https' \| 'ssh'`            | Determines the credential and the push mechanism.         |
| `url`         | `string`                      | `https://github.com/acme/app.git` or `git@github.com:acme/app.git`. |
| `secretRef`   | `string`                      | A Secrets Store key. **Never the secret itself.**         |
| `hostKeyRef`  | `string \| null`              | Required when `protocol === 'ssh'`. Pinned known-hosts.   |
| `allowedRefs` | `string[]`                    | Glob patterns for refs that may be pushed.                |

**Invariants.**
- `secretRef` is a reference. A `Remote` object containing a live secret is a bug, and the type
  system should make it unrepresentable.
- `protocol === 'ssh'` requires a non-null `hostKeyRef` (FR-GIT-130).
- `allowedRefs` is non-empty. An empty list would mean "push anything", which is not a default
  anyone should get by accident.

### `Session`

A unit of work. One branch, one container, one agent.

| Field            | Type              | Notes                                                       |
| ---------------- | ----------------- | ----------------------------------------------------------- |
| `id`             | `string`          | Server-generated. A valid DNS label.                        |
| `projectId`      | `string`          |                                                             |
| `title`          | `string`          | Derived from the task, user-editable.                        |
| `task`           | `string`          | The original instruction.                                    |
| `branch`         | `string`          | `codeflare/<session-id>`.                                        |
| `baseBranch`     | `string`          | What it branched from and what it merges into.               |
| `status`         | `SessionStatus`   | See the state machine below.                                 |
| `ownerEmail`     | `string`          | The initiating human. Authorization is checked against this. |
| `containerState` | `ContainerState`  |                                                              |
| `snapshotId`     | `string \| null`  | Set when snapshotted, cleared when superseded.               |
| `previewHost`    | `string \| null`  | `<session-id>.preview.<domain>` when a preview is live.      |
| `usage`          | `Usage`           | Accumulated cost.                                            |
| `lastActivityAt` | `string`          | ISO 8601. Drives idle decisions.                             |
| `createdAt`      | `string`          | ISO 8601.                                                    |

**Invariants.**
- `id` matches `/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/`. It is a DNS label for the preview
  hostname and a tmux session name, so it cannot contain `.` or `:`.
- `branch` is unique within the project.
- `ownerEmail` is immutable after creation.
- `status === 'sleeping'` implies `snapshotId !== null`. A session cannot be asleep with no saved
  filesystem — that would silently lose work.
- `previewHost !== null` implies `containerState.running === true`.

### `SessionStatus`

```ts
type SessionStatus =
  | 'creating'        // repo branch being created, container starting
  | 'ready'           // container up, idle, awaiting instruction
  | 'working'         // an agent turn is in flight
  | 'awaiting-input'  // agent paused for approval or clarification
  | 'sleeping'        // container stopped, snapshot saved, resumable
  | 'archived'        // terminal, read-only, branch preserved
  | 'failed';         // terminal, needs human attention
```

### `ContainerState`

| Field                 | Type              | Notes                                                    |
| --------------------- | ----------------- | -------------------------------------------------------- |
| `running`             | `boolean`         | Mirrors `ctx.container.running`, never cached stale.     |
| `image`               | `string`          | The digest-pinned reference actually started.            |
| `instance`            | `InstanceSize`    |                                                          |
| `startedAt`           | `string \| null`  |                                                          |
| `inactivityTimeoutMs` | `number`          | Re-applied by the DO constructor on restart.             |
| `devServer`           | `DevServerState`  |                                                          |

### `DevServerState`

| Field       | Type                                                        |
| ----------- | ----------------------------------------------------------- |
| `status`    | `'stopped' \| 'starting' \| 'ready' \| 'crashed'`           |
| `pid`       | `number \| null`                                            |
| `port`      | `number`                                                    |
| `logPath`   | `string`                                                    |
| `lastError` | `string \| null`                                            |

### `Message`

A transcript entry. Persisted in `SessionDO` SQLite.

| Field       | Type                                              |
| ----------- | ------------------------------------------------- |
| `id`        | `string`                                          |
| `seq`       | `number` — monotonic per session, drives replay   |
| `role`      | `'user' \| 'assistant' \| 'tool' \| 'system'`     |
| `content`   | `string`                                          |
| `toolCalls` | `ToolCall[]`                                      |
| `createdAt` | `string`                                          |

**Invariant.** `seq` is strictly increasing with no gaps. Reconnect replay is "give me everything
after seq N", so a gap or a reuse breaks FR-SESS-050.

### `ToolCall`

| Field        | Type                                                    |
| ------------ | ------------------------------------------------------- |
| `id`         | `string`                                                |
| `name`       | `string`                                                |
| `args`       | `Record<string, unknown>` — redacted before persistence |
| `status`     | `'pending' \| 'approved' \| 'running' \| 'ok' \| 'error' \| 'rejected'` |
| `result`     | `string \| null` — truncated for display                |
| `durationMs` | `number \| null`                                        |

### `MergeRequest`

An entry in the project merge queue.

| Field         | Type                                                              |
| ------------- | ----------------------------------------------------------------- |
| `id`          | `string`                                                          |
| `sessionId`   | `string`                                                          |
| `sourceBranch`| `string`                                                          |
| `targetBranch`| `string`                                                          |
| `status`      | `'queued' \| 'merging' \| 'merged' \| 'conflicted' \| 'rejected'` |
| `conflicts`   | `ConflictFile[]`                                                  |
| `requestedBy` | `string`                                                          |
| `mergeCommit` | `string \| null`                                                  |

**Invariant.** At most one `MergeRequest` per project is in `merging` at any time. This is the whole
reason `ProjectDO` exists.

### `Usage` and `Budget`

| `Usage` field       | Type     | `Budget` field       | Type     |
| ------------------- | -------- | -------------------- | -------- |
| `modelInputTokens`  | `number` | `maxModelSpendUsd`   | `number` |
| `modelOutputTokens` | `number` | `maxContainerMinutes`| `number` |
| `modelSpendUsd`     | `number` | `maxTurns`           | `number` |
| `containerMs`       | `number` |                      |          |
| `turns`             | `number` |                      |          |

**Invariant.** Every budget field is a hard stop, not a warning. Crossing one transitions the
session to `awaiting-input` with a budget-exceeded reason. An agent turn checks the budget before
starting and cannot begin over budget.

## 2. Session state machine

```text
                      create
                         │
                         ▼
                   ┌───────────┐  container start or clone fails
                   │ creating  │──────────────────────────────┐
                   └─────┬─────┘                              │
                 ready   │                                    │
                         ▼                                    │
    ┌───────────────┬──────────┬────────────────┐             │
    │               │  ready   │                │             │
    │               └────┬─────┘                │             │
    │        message     │        idle timeout  │             │
    │                    ▼                      ▼             │
    │              ┌──────────┐           ┌───────────┐       │
    │      ┌──────▶│ working  │           │ sleeping  │       │
    │      │       └────┬─────┘           └─────┬─────┘       │
    │      │  approved  │ needs approval        │ message     │
    │      │            ▼                       │             │
    │      │     ┌──────────────┐               │             │
    │      └─────│awaiting-input│               │             │
    │            └──────┬───────┘               │             │
    │                   │ abandoned             │             │
    │  turn complete    ▼                       │             │
    └───────────── (back to ready) ◀────────────┘             │
                         │                                    │
              archive    │        unrecoverable error         │
                         ▼                  ▼                 ▼
                   ┌──────────┐        ┌──────────┐◀──────────┘
                   │ archived │        │  failed  │
                   └──────────┘        └──────────┘
```

Transition rules that are easy to get wrong:

| From             | To               | Trigger                              | Required side effects                                                      |
| ---------------- | ---------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `creating`       | `ready`          | Container running and branch cloned  | Set inactivity timeout; register preview host mapping.                     |
| `ready`          | `working`        | User message or resumed task         | Check budget **first**; start container if stopped; set alarm.             |
| `working`        | `awaiting-input` | Approval needed or budget exceeded   | Persist pending approval; stop the keepalive alarm.                        |
| `working`        | `ready`          | Turn completed                       | Commit and push branch; persist transcript; keep alarm only if work remains. |
| `ready`          | `sleeping`       | Idle beyond threshold                | Snapshot **then** `destroy()`. Never the other way round.                   |
| `sleeping`       | `working`        | New message                          | Start from snapshot; **fail loudly** if restore fails; restart dev server if it was running. |
| any non-terminal | `archived`       | User archives                        | Snapshot, destroy container, tear down preview host and Access entry.      |
| any non-terminal | `failed`         | Unrecoverable error                  | Preserve branch; record diagnostics; destroy container; tear down preview. |

**The restore rule, stated explicitly because it is a real trap.** When `snapshotId` is set and the
restore fails, the session goes to `failed`. It does **not** fall back to starting from the base
image, because that would present an empty workspace as if it were the user's work.

## 3. Naming derivations

Every name is derived server-side. No client input reaches any of these.

| Thing                    | Derivation                                     | Example                                    |
| ------------------------ | ---------------------------------------------- | ------------------------------------------ |
| Artifacts repo           | `<project-slug>`                               | `acme-app`                                  |
| Session branch           | `codeflare/<session-id>`                           | `codeflare/s7k2m9x4qp1w`                        |
| Session DO key           | `<project-id>:<session-id>`                    | `p3n8:s7k2m9x4qp1w`                         |
| Project DO key           | `<project-id>`                                 | `p3n8`                                      |
| Preview hostname         | `<session-id>.preview.<domain>`                | `s7k2m9x4qp1w.preview.codeflare.example.com`    |
| tmux session name        | `<terminal-name>` (default `main`)             | `main`                                      |
| Snapshot name            | `<session-id>-<iso-timestamp>`                 | `s7k2m9x4qp1w-2026-09-30T14-22-01Z`         |

**Security note, worth repeating.** The Durable Object key decides which sandbox — and therefore
which saved files — a request reaches. It does not prove who is asking. Authenticate the caller in
the Worker, then check `ownerEmail` and project membership, *then* derive the key. This is
FR-AUTH-050 and it is the single most important line in this document.

## 4. Validation rules

All validation lives in the domain tier so every transport enforces it identically.

| Input              | Rule                                                                           |
| ------------------ | ------------------------------------------------------------------------------ |
| Project name       | 1–64 chars, no control characters.                                             |
| Project slug       | `/^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/`, unique in the namespace.           |
| Import URL         | `https:` only; host on an allowlist (`github.com`, `gitlab.com`, configured self-hosted). No credentials in the URL. |
| Branch name        | Valid git ref; no `..`, no leading `-`, no control characters, no whitespace.   |
| Session task       | 1–8,000 chars.                                                                 |
| File path          | Normalised, absolute within `/workspace`. Traversal outside is rejected.        |
| File write size    | ≤ 1 MiB through the editor API.                                                |
| Shell command      | Non-empty; ≤ 8,000 chars; executed with an explicit timeout.                   |
| Dev port           | 1024–65535.                                                                    |
| Remote URL         | Matches the declared protocol; host on the provider allowlist.                 |
| Ref to publish     | Matches at least one `allowedRefs` glob.                                       |

## 5. Domain events

Emitted by the domain tier, consumed by the API tier for streaming and by the audit log.

| Event                     | Payload                                  |
| ------------------------- | ---------------------------------------- |
| `session.created`         | `sessionId, projectId, branch`            |
| `session.status-changed`  | `sessionId, from, to, reason`             |
| `session.message-appended`| `sessionId, seq, role`                    |
| `agent.turn-started`      | `sessionId, turnId`                       |
| `agent.turn-finished`     | `sessionId, turnId, outcome, usage`       |
| `agent.tool-called`       | `sessionId, toolCallId, name, status`     |
| `agent.approval-required` | `sessionId, toolCallId, summary`          |
| `workspace.files-changed` | `sessionId, paths[], kind`                |
| `preview.status-changed`  | `sessionId, from, to`                     |
| `git.committed`           | `sessionId, sha, message`                 |
| `git.pushed`              | `sessionId, branch, remote`               |
| `merge.queued`            | `projectId, mergeRequestId`               |
| `merge.completed`         | `projectId, mergeRequestId, outcome`      |
| `budget.exceeded`         | `sessionId, dimension, limit, actual`     |
| `container.started`       | `sessionId, image, instance`              |
| `container.stopped`       | `sessionId, reason`                       |

Every event carries `occurredAt` and the `correlationId` required by FR-OPS-070.
