# 10 — API contracts

These contracts are frozen for parallel work. HTTP endpoints return JSON unless stated otherwise.
Every failure uses RFC 9457 `application/problem+json` via the toolkit error handler.

Base control-plane URL: `https://codeflare.example.com/api`

## 1. Common rules

### Authentication

All non-public routes require Access. The Worker validates the JWT and injects a typed
`AuthenticatedUser` into the request context. Clients do not send user IDs.

### Headers

| Header                | Meaning                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `Idempotency-Key`     | Required on all creation/mutation requests; 16–128 printable chars.     |
| `If-Match`            | Required for file write/update based on an existing content hash.        |
| `X-Request-Id`        | Optional caller correlation identifier; server emits/returns one always. |

### Problem shape

```json
{
  "type": "https://codeflare.example.com/problems/session-not-found",
  "title": "Session not found",
  "status": 404,
  "detail": "The requested session does not exist or is no longer available.",
  "instance": "/api/sessions/s7k2m9x4qp1w",
  "requestId": "req_…"
}
```

`detail` is safe for the user. Stack traces, upstream response bodies, secret references, container
paths outside `/workspace`, and binding names are never included.

### Domain error mapping

| Domain error                   | HTTP | Problem type suffix                  |
| ------------------------------ | ---- | ------------------------------------ |
| Invalid input                  | 400  | `validation-failed`                  |
| Unauthenticated                | 401  | `authentication-required`            |
| Authenticated but unauthorised | 403  | `forbidden`                          |
| Missing resource               | 404  | `not-found`                          |
| Revision conflict              | 409  | `revision-conflict`                  |
| State transition invalid       | 409  | `invalid-session-state`              |
| Budget exceeded                | 409  | `budget-exceeded`                    |
| External provider unavailable  | 502  | `upstream-unavailable`               |
| Timeout                        | 504  | `operation-timed-out`                |

## 2. Projects

### `GET /projects`

Lists projects visible to the caller.

```json
{
  "projects": [
    {
      "id": "p3n8",
      "name": "Marketing site",
      "slug": "marketing-site",
      "defaultBranch": "main",
      "activeSessionCount": 2,
      "lastActivityAt": "2026-09-30T12:00:00Z",
      "role": "admin"
    }
  ],
  "nextCursor": null
}
```

### `POST /projects`

`Idempotency-Key` required.

```json
{
  "name": "Marketing site",
  "source": {
    "kind": "import",
    "remoteUrl": "https://github.com/acme/marketing-site.git",
    "credentialId": "optional-admin-configured-reference"
  },
  "defaultBranch": "main",
  "budget": { "maxModelSpendUsd": 25, "maxContainerMinutes": 180, "maxTurns": 100 }
}
```

`source.kind`: `import | empty | template`.

Success `201` returns `ProjectDetail`, initially with `provisioningStatus: 'detecting'`. Import and
toolchain detection can continue in a durable background job; clients observe completion from
project events/polling.

### `GET /projects/:projectId`

Returns project detail, members (subject to role), toolchain, remotes without secret refs, sessions
summary, and merge queue.

### `PATCH /projects/:projectId`

Admin only. Accepts selected `name`, `toolchain`, `instanceSize`, and `budget` fields. Changing
image/toolchain does not mutate existing running sessions; it applies to later starts and must warn
the user about snapshot image compatibility.

### `DELETE /projects/:projectId`

Admin only, `Idempotency-Key` required. Returns `202` with a deletion operation ID. The operation
is observable at `GET /operations/:operationId` until terminal.

## 3. Sessions

### `POST /projects/:projectId/sessions`

`Idempotency-Key` required.

```json
{
  "task": "Add a pricing section with responsive cards and test it.",
  "title": "Build pricing section",
  "baseBranch": "main"
}
```

Success `201`:

```json
{
  "id": "s7k2m9x4qp1w",
  "projectId": "p3n8",
  "branch": "codeflare/s7k2m9x4qp1w",
  "baseBranch": "main",
  "status": "creating",
  "webUrl": "/sessions/s7k2m9x4qp1w"
}
```

### `GET /sessions/:sessionId`

Returns `SessionDetail`, including current status, branch/base, preview state, budget/usage,
terminal names, and latest transcript page. Never returns secrets or raw container identifiers.

### `POST /sessions/:sessionId/messages`

`Idempotency-Key` required.

```json
{ "content": "Please also make the cards keyboard accessible." }
```

Returns `202`:

```json
{ "turnId": "turn_…", "status": "accepted" }
```

Actual tokens/events arrive through the session WebSocket. This endpoint is intentionally not a
long-held streaming HTTP response, so browsers can disconnect without affecting work.

### `POST /sessions/:sessionId/stop`

User owner/admin only. Stops current turn, snapshots, stops container. `202` with operation status.

### `POST /sessions/:sessionId/archive`

Owner/admin only. Archives permanently (subject to retention): snapshot, container stop, preview
teardown. `202`.

### `POST /sessions/:sessionId/approvals/:approvalId`

```json
{ "decision": "approve", "approvalHash": "sha256:…" }
```

`decision`: `approve | reject`. Hash mismatch is 409. Duplicate decision is idempotent.

### `POST /sessions/:sessionId/merge-requests`

```json
{ "targetBranch": "main" }
```

Queues the branch for serial merge. Returns `202` with `MergeRequest`.

## 4. Workspace

### `GET /sessions/:sessionId/files?path=/workspace&depth=1`

Returns a lazy file-tree subtree:

```json
{
  "revision": "tree-sha-or-monotonic-revision",
  "entries": [
    { "path": "/workspace/app", "name": "app", "kind": "directory", "gitStatus": "modified" },
    { "path": "/workspace/package.json", "name": "package.json", "kind": "file", "size": 814, "gitStatus": "clean" }
  ]
}
```

### `GET /sessions/:sessionId/files/content?path=/workspace/app/page.tsx`

Text files only. Returns:

```json
{
  "path": "/workspace/app/page.tsx",
  "content": "…",
  "contentHash": "sha256:…",
  "language": "typescriptreact",
  "size": 8241
}
```

Binary/oversized return `415` problem `file-not-editable` with safe metadata.

### `PUT /sessions/:sessionId/files/content?path=/workspace/app/page.tsx`

Requires `If-Match` with the previous `contentHash`.

```json
{ "content": "…" }
```

Success returns new hash. Mismatch returns 409 with `currentContentHash`; the server does not echo
full conflicting content by default, so a client asks `GET` to compare.

### `GET /sessions/:sessionId/diff?base=main`

Returns paginated file diff summary. `GET /sessions/:sessionId/diff/files?path=…` returns a unified
text patch or binary metadata.

## 5. Terminal and session event WebSockets

### `GET /sessions/:sessionId/events` with `Upgrade: websocket`

The client first sends:

```json
{ "type": "resume", "lastEventSeq": 42 }
```

The server sends either a snapshot then events, or events after 42 if it can prove continuity.

Event envelope:

```json
{
  "type": "agent.tool-called",
  "seq": 43,
  "occurredAt": "2026-09-30T12:00:01.234Z",
  "correlationId": "req_…",
  "data": { "toolCallId": "tool_…", "name": "run_command", "status": "running" }
}
```

Event names are the domain events in [03-domain-model.md](./03-domain-model.md). All clients must
ignore unknown event types to permit additive evolution.

### `GET /sessions/:sessionId/terminal?name=main&cols=120&rows=40` with `Upgrade: websocket`

- Raw terminal bytes, not JSON after upgrade.
- User must have session access.
- Name is a validated tmux-safe DNS-label-like value.
- Resize is a compact JSON control frame or a documented terminal escape protocol; pick one and
  freeze it before terminal/frontend packages begin. **Recommended:** JSON frames prefixed by a
  reserved control byte, leaving all other data as terminal bytes.

## 6. Preview management

### `POST /sessions/:sessionId/preview/start`

Starts/restarts declared dev server. Returns `202`:

```json
{
  "status": "starting",
  "url": "https://s7k2m9x4qp1w.codeflare-previews.example.com/"
}
```

### `POST /sessions/:sessionId/preview/stop`

Stops only the dev-server process. Does not archive session. Returns current preview state.

### `GET /sessions/:sessionId/preview/logs?tail=200`

Returns a sanitised tail. Server limits `tail` to 1–500 lines.

## 7. Publishing

### `POST /sessions/:sessionId/publish`

Human interaction required; no agent-equivalent endpoint/tool exists.

```json
{
  "remoteId": "remote_…",
  "sourceBranch": "codeflare/s7k2m9x4qp1w",
  "targetRef": "refs/heads/codeflare/s7k2m9x4qp1w"
}
```

`Idempotency-Key` required. Returns `202` because push runs in an ephemeral publisher:

```json
{ "operationId": "pub_…", "status": "running" }
```

`GET /operations/:operationId` returns state and result:

```json
{
  "id": "pub_…",
  "kind": "publish",
  "status": "succeeded",
  "result": {
    "remoteUrl": "https://github.com/acme/marketing-site/tree/codeflare/s7k2m9x4qp1w",
    "pushedCommit": "abc123…"
  }
}
```

## 8. Internal RPC contracts

Use TypeScript interfaces, imported from one contracts package. Cap'n Web session RPC is additive;
public HTTP is authoritative for external integrations.

```ts
export interface SessionRpc {
  /** Returns a consistent session snapshot and its event watermark. */
  getSnapshot(): Promise<SessionSnapshot>;
  /** Appends an authorised user message idempotently and admits a turn. */
  submitMessage(input: SubmitMessageInput): Promise<TurnAcceptance>;
  /** Reads a workspace subtree after path and identity validation. */
  listFiles(input: ListFilesInput): Promise<FileTree>;
  /** Reads a text file and its optimistic-concurrency hash. */
  readFile(input: ReadFileInput): Promise<FileContent>;
  /** Writes a file if the supplied base hash matches. */
  writeFile(input: WriteFileInput): Promise<FileWriteResult>;
  /** Starts the preview using the declared toolchain. */
  startPreview(): Promise<PreviewState>;
  /** Opens/re-attaches terminal PTY transport. */
  openTerminal(input: OpenTerminalInput): Promise<TerminalCapability>;
}

export interface ProjectRpc {
  /** Enqueues a merge and returns its durable queue entry. */
  enqueueMerge(input: EnqueueMergeInput): Promise<MergeRequest>;
  /** Returns project live-session summaries. */
  listLiveSessions(): Promise<SessionSummary[]>;
}
```

A `TerminalCapability` is an object capability, not an arbitrary session identifier. It is scoped to
the authenticated session and terminal name.
