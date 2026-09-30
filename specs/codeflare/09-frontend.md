# 09 — Frontend

## 1. Technology and boundaries

The frontend is vinext App Router on Cloudflare Workers, following `vinext-demos/AGENTS.md` exactly:

- App Router (`app/`), React, TypeScript.
- Server Components by default.
- `'use client'` only for interactive islands.
- `cloudflareAccessPlugin({ policies })` before `vinext()` and `cloudflare()` in Vite configuration.
- `cloudflare:workers` only in server components, server actions, or route handlers — never a
  client component.
- UI accesses backend state only by same-origin HTTP/WebSocket. It never accesses bindings.

`@cloudflare/ai-chat/react` drives the chat surface; Monaco is the editor; xterm.js is terminal.

## 2. Route map

| Route                              | Protection | Purpose                                                  |
| ---------------------------------- | ---------- | -------------------------------------------------------- |
| `/`                                | Public     | Landing page, sign-in link, product explanation.        |
| `/health`                          | Public     | Minimal health response, no dependency detail.           |
| `/projects`                        | Access     | Project list.                                            |
| `/projects/new`                    | Access     | Create/import/fork project wizard.                       |
| `/projects/:projectId`             | Access     | Project overview, sessions, branches, remotes.           |
| `/projects/:projectId/settings`    | Admin      | Members, budgets, remotes, toolchain.                    |
| `/sessions/:sessionId`             | Access + ownership | Four-pane coding surface.                         |
| `/api/**`                          | Policy-specific | Hono API adapter.                                   |
| `https://<session>.preview-domain` | Access     | Container proxy only. No App Router UI routes.           |

A public root must stay genuinely public. It links to the protected app; it does not client-side
redirect unauthenticated visitors into an Access challenge.

## 3. Primary screens

### Project list

- Accessible table/cards: project name, default branch, active session count, last activity, owner.
- Create Project button.
- Empty state explains import vs template.
- Project deletion is a deliberate destructive-flow dialog that tells the user the repo, branches,
  snapshots and previews that will be removed.

### Create project wizard

1. **Source:** public HTTPS import, private HTTPS import, empty, or template.
2. **Repository:** validate provider URL; private flow selects an admin-configured credential rather
   than pasting one.
3. **Detection:** show detected manager, install/dev/test/build commands and port. User confirms or
   overrides.
4. **Resources:** choose bounded instance tier and budget.
5. **Review:** explicitly state that source is stored in Artifacts and model context is sent via AI
   Gateway to the configured provider.

### Project overview

- Sessions grouped by state: Working, Needs input, Ready, Sleeping, Archived/Failed.
- “New session” task form with base branch selector.
- Merge queue with status, conflicts, and merge result SHA.
- Recent Artifacts push/CI events.
- External remotes and publish history; secrets are never rendered.

### Session coding surface

Desktop layout is resizable panes:

```text
┌───────────┬──────────────────────────────┬────────────────────────┐
│ files     │ editor / diff                │ agent chat             │
│           │                              │ agent work events      │
├───────────┴──────────────────────────────┼────────────────────────┤
│ terminal                                 │ preview iframe/status  │
└──────────────────────────────────────────┴────────────────────────┘
```

On small viewports, use tabs: **Chat**, **Files**, **Terminal**, **Preview**. Do not attempt to
squeeze four panes into mobile.

Persistent session header:

- Status and connection indicator.
- Branch and base branch.
- Cost/runtime display.
- Start/stop preview.
- Diff, request merge, archive.
- Publish menu (always human-clicked).

## 4. Client state model

The server is authoritative. The client is a projection that can disappear at any time.

```ts
interface SessionViewState {
  session: SessionSummary;
  messages: Message[];       // ordered by durable seq
  files: FileTreeNode[];
  openBuffers: Map<AbsolutePath, EditorBuffer>;
  terminalConnections: Map<TerminalName, TerminalConnection>;
  preview: PreviewStatus;
  lastEventSeq: number;
  connection: 'connecting' | 'connected' | 'reconnecting' | 'offline';
}
```

On WebSocket open:

1. Send the last durable event sequence (or no sequence for a first connection).
2. Receive `session.snapshot`, which has current status, transcript watermark, files revision,
   preview state, pending approvals and current usage.
3. Apply subsequent ordered events.
4. Ignore an already-applied sequence; request a fresh snapshot if a gap is detected.

The UI never optimistic-updates a command as completed. It may render an optimistic “queued” state,
but the durable event is the completion authority.

## 5. Chat

Chat must make agent activity comprehensible, not merely imitate a messaging app.

### Rendered item types

| Type                | Rendering                                                                 |
| ------------------- | ------------------------------------------------------------------------- |
| User message        | Plain text, timestamp, editable until turn starts.                        |
| Assistant text      | Incremental Markdown with sanitised links/code.                           |
| Tool call           | Collapsible card: name, safe argument summary, running/success/error.    |
| Tool result         | Truncated ANSI-safe text, “open full log” when stored in R2.              |
| Approval            | Clear high-attention card: exact operation, files/refs, Approve/Reject.  |
| Background agent    | Progress bar, phase, cancel button.                                       |
| System/session      | Small state event: slept, restored, budget reached, reconnecting.        |

Markdown is sanitised. Never render model-provided HTML. Tool argument and result renderers assume
untrusted content; secrets must already be redacted server-side, but client-side rendering still
never treats values as HTML.

### Accessibility

- The transcript is a labelled `role="log"`.
- Streaming text is announced through one `aria-live="polite"` region, coalesced no more often than
  every 1–2 seconds, so screen readers are not flooded token by token.
- Approval controls receive focus when they arrive, but only when the user is not actively typing.
- Stop, retry, approve, and reject all have keyboard-accessible buttons and clear names.

## 6. Files and Monaco

### File tree

- Lazy-expand directories; fetch child lists on demand.
- Render git status badges: modified, added, deleted, untracked.
- Detect binary/oversize files server-side and show a non-editor detail state.
- Keyboard tree semantics: arrows navigate, Enter opens, Space toggles expansion.

### Buffers and conflicts

Each open buffer tracks a base content hash/revision:

```ts
interface EditorBuffer {
  path: string;
  baseHash: string;
  value: string;
  dirty: boolean;
  externallyChanged: boolean;
}
```

On agent file-change event:

- Clean buffer: fetch new content and replace, preserving cursor where possible.
- Dirty buffer: mark externally changed and offer **Reload agent change**, **Keep my draft**, or
  **Compare**. Never silently replace human text.

Save uses `PUT /api/sessions/:id/files/:path` with `If-Match: <baseHash>`. A mismatch returns a
409 RFC 9457 conflict with current hash/content metadata. The client opens the diff resolver.

Monaco and language workers are lazy-loaded. Do not make the first session paint wait on Monaco.

## 7. Terminal and xterm.js

- Terminal panel connects to `wss://codeflare.example.com/api/sessions/:id/terminal?name=main`.
- xterm's fit addon sends rows/columns on resize; DO forwards them to the PTY.
- Reconnect attaches to the same tmux session, which retains scrollback. The terminal UI itself does
  not try to persist terminal history in localStorage.
- Every terminal has an accessible label, e.g. “Session terminal: main”.
- Copy/paste behaviour and shortcuts are documented, including an accessible alternate mechanism
  for users who cannot use modifier-key terminal conventions.
- The terminal does not interpolate output as HTML. xterm receives raw terminal bytes.

## 8. Preview UI

- Sandbox iframe and status/log sidebar, per [08-previews.md](./08-previews.md).
- Do not make an iframe auto-start on initial page render; start it after user intent or an existing
  live-preview state, to avoid cold-starting containers just by browsing a project.
- Frame has a meaningful title and an “open preview in new tab” fallback.
- Error view shows a safe tail of dev-server log, not a raw Worker exception.

## 9. Visual and interaction quality

This is a coding environment, not a marketing page.

- Use a dense but readable IDE layout with clear pane dividers and resizable handles of at least
  24px pointer target width.
- Support dark/light/system themes; Monaco and xterm theme follows it.
- Connection state is visible but unobtrusive. When reconnecting, inputs that will queue are
  labelled as such; destructive controls are disabled until connection returns.
- Use skeletons for project/session initial loads, never a blank screen.
- Respect `prefers-reduced-motion` for streaming cursor/transition effects.

## 10. UI test expectations

React Testing Library tests visible behaviour and accessible controls, not component internals:

- Session screen reports reconnecting then applies state snapshot.
- Tool event is rendered, collapsible, and result accessible.
- Approval cannot be submitted twice; rejection renders a terminal state.
- Dirty editor buffer is never clobbered by agent event.
- Preview iframe uses the separate-origin URL and sandbox policy.
- Keyboard navigation reaches every interactive pane/control.

Playwright/E2E, when added, verifies actual WebSocket terminal reconnect and preview HMR in a
real Workers runtime.
