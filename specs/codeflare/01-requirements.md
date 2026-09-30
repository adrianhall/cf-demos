# 01 — Requirements

Every requirement has a stable identifier. Tests reference the identifier. A package is not
complete until every MUST it owns has a passing test named for it.

**MUST** — gate on Definition of Done.
**SHOULD** — may be deferred to a later milestone with a recorded reason.
**MAY** — optional; implement only if it costs nothing.

---

## FR-AUTH — Identity and authorization

| ID          | Level  | Requirement                                                                                                                                                                                                  |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-AUTH-010 | MUST   | Every Codeflare control-plane route is protected by a Cloudflare Access application. Unauthenticated requests never reach application logic.                                                                     |
| FR-AUTH-020 | MUST   | The application independently validates the `Cf-Access-Jwt-Assertion` token against the team JWKS **and** verifies the `aud` claim matches this application's AUD. Edge enforcement alone is not sufficient. |
| FR-AUTH-030 | MUST   | The authenticated identity (Access `email` / `sub`) is the sole source of the acting user. No user identifier is ever read from a request path, query string, or body for authorization purposes.             |
| FR-AUTH-040 | MUST   | A user may read and act on a project only if they are a member of it. Membership is checked in the application tier on every request, not only at the edge.                                                  |
| FR-AUTH-050 | MUST   | Session, container, and Artifacts repository names are derived server-side from the authenticated identity plus a server-generated ID. A client-supplied name never selects a sandbox.                       |
| FR-AUTH-060 | MUST   | Local development emulates Access rather than disabling it, via the toolkit's Access local-development Vite plugin. The local and deployed authorization paths are identical code.                            |
| FR-AUTH-070 | MUST   | Development-token bypass is gated on a build-time flag that is statically `false` in a production build, so the bypass branch is removed by the bundler.                                                     |
| FR-AUTH-080 | MUST   | Public routes (health, the unauthenticated landing page) are public by an explicit Access bypass policy in a single shared policy definition used by both local development and deployment.                   |
| FR-AUTH-090 | SHOULD | Two roles exist: `member` (create and run sessions, publish to configured remotes) and `admin` (manage projects, remotes, budgets, and members). Enforced in the application tier.                            |

## FR-PROJ — Projects

| ID          | Level  | Requirement                                                                                                                                                                                       |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-PROJ-010 | MUST   | A user can create a project by importing a public HTTPS git remote into an Artifacts repository.                                                                                                  |
| FR-PROJ-015 | MUST   | A user can create a project by importing a **private** remote, using a credential held by the Worker and never exposed to any container.                                                          |
| FR-PROJ-020 | MUST   | A user can create an empty project, or fork a template project, without an external remote.                                                                                                       |
| FR-PROJ-030 | MUST   | A project records: display name, Artifacts namespace and repo, default branch, detected package manager, detected dev-server command and port, and member list.                                   |
| FR-PROJ-040 | MUST   | Project detection inspects the imported tree for `package.json`, a lockfile, and a framework signature, and proposes install/dev/test/build commands. The user can override every proposed value. |
| FR-PROJ-050 | MUST   | Deleting a project deletes its Artifacts repository, every session, every snapshot, every preview DNS binding, and its Access application entries. Deletion is idempotent.                         |
| FR-PROJ-060 | SHOULD | A project can declare a base container image from a curated set, so a project needing a non-default toolchain is not forced into the default image.                                               |

## FR-SESS — Sessions

| ID          | Level  | Requirement                                                                                                                                                                             |
| ----------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-SESS-010 | MUST   | A session is created from a project with a task description and an optional base branch. It gets a server-generated ID, a dedicated git branch, and a dedicated container.              |
| FR-SESS-020 | MUST   | A session is backed by one Durable Object. All session state — messages, task status, container handle, snapshot ID — lives in its SQLite storage.                                      |
| FR-SESS-030 | MUST   | A client connects to a session over WebSocket and receives a full state snapshot on connect, followed by incremental events.                                                            |
| FR-SESS-040 | MUST   | Disconnecting the client does not stop the agent. Work in progress continues and is observable when the client reconnects.                                                              |
| FR-SESS-050 | MUST   | Reconnecting replays state so the UI is consistent with the server. No message is lost or duplicated; event ordering is preserved.                                                      |
| FR-SESS-060 | MUST   | A session has an explicit lifecycle — `creating`, `ready`, `working`, `awaiting-input`, `sleeping`, `archived`, `failed` — with the transitions in [03-domain-model.md](./03-domain-model.md). |
| FR-SESS-070 | MUST   | A project supports at least 10 concurrent live sessions without cross-session interference.                                                                                            |
| FR-SESS-080 | MUST   | A user can stop a session, which terminates the agent turn, snapshots the filesystem, and stops the container.                                                                         |
| FR-SESS-090 | MUST   | A user can archive a session, which snapshots, stops, and preserves the branch and transcript read-only.                                                                                |
| FR-SESS-100 | SHOULD | A session can be forked, producing a new session from the same branch point with the transcript copied to that point.                                                                   |

## FR-AGENT — The agent

| ID           | Level  | Requirement                                                                                                                                                                       |
| ------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-AGENT-010 | MUST   | The agent harness is `@cloudflare/think`, running inside the session Durable Object.                                                                                              |
| FR-AGENT-020 | MUST   | All model traffic goes through AI Gateway. The gateway token lives in the Worker and never enters a container.                                                                    |
| FR-AGENT-030 | MUST   | The agent has file tools (`read`, `write`, `edit`, `ls`, `grep`, `find`) operating on the container working tree.                                                                 |
| FR-AGENT-040 | MUST   | The agent has a shell tool that runs a command in the container with a bounded timeout and truncated output, returning exit code, stdout, and stderr.                             |
| FR-AGENT-050 | MUST   | The agent has git tools: status, diff, add, commit, and branch inspection. The agent cannot push to an external remote; publishing is a human-initiated control-plane action.     |
| FR-AGENT-060 | MUST   | The agent streams its turn — text, tool calls, tool results, errors — to every connected client in real time.                                                                     |
| FR-AGENT-070 | MUST   | A turn survives Durable Object eviction and Worker deployment. An interrupted turn is either resumed or cleanly marked failed with a repaired message history; it never hangs.    |
| FR-AGENT-080 | SHOULD | The agent can dispatch background sub-agents for bounded independent work, reporting progress, with an absolute budget ceiling and a cancel path.                                 |
| FR-AGENT-090 | MUST   | Every tool call is recorded with its arguments, result summary, duration, and outcome, and is visible in the transcript.                                                          |
| FR-AGENT-100 | MUST   | Destructive operations outside the working tree — deleting the repository, rewriting history, force operations — require explicit human approval before execution.                |
| FR-AGENT-110 | SHOULD | The agent can run the project's test command and read the result as structured data, not only as raw text.                                                                        |

## FR-WS — Workspace and editor

| ID        | Level  | Requirement                                                                                                                                                       |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-WS-010 | MUST   | The UI shows a file tree of the session working tree, with lazy directory expansion.                                                                              |
| FR-WS-020 | MUST   | Opening a file loads it into a Monaco editor with syntax highlighting appropriate to its extension.                                                               |
| FR-WS-030 | MUST   | A human can edit and save a file. The save writes to the container working tree and is visible to the agent's next tool call.                                     |
| FR-WS-040 | MUST   | When the agent changes a file the user has open, the UI indicates the change. If the buffer is unmodified it refreshes; if modified it prompts rather than clobbering. |
| FR-WS-050 | MUST   | The file tree reflects agent-caused creations, deletions, and renames within 2 seconds of the tool call completing.                                               |
| FR-WS-060 | MUST   | Binary and oversized files are detected and refused with a clear message rather than loaded into the editor.                                                      |
| FR-WS-070 | SHOULD | The editor shows per-file git status (modified, added, untracked) in the tree.                                                                                    |
| FR-WS-080 | SHOULD | A diff view shows the session branch against its base branch, file by file.                                                                                       |

## FR-TERM — Terminal

| ID          | Level  | Requirement                                                                                                                                       |
| ----------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-TERM-010 | MUST   | The UI provides an xterm.js terminal attached over WebSocket to an interactive shell in the session container.                                    |
| FR-TERM-020 | MUST   | The shell runs inside a tmux session, so the shell and its running processes survive a page reload or a dropped connection.                       |
| FR-TERM-030 | MUST   | Reattaching to a terminal restores scrollback and the live process, not a fresh shell.                                                            |
| FR-TERM-040 | MUST   | Terminal resize propagates to the pseudo-terminal so full-screen programs render correctly.                                                       |
| FR-TERM-050 | MUST   | An open terminal counts as session activity and keeps the container alive.                                                                        |
| FR-TERM-060 | MUST   | The terminal is subject to the same egress policy as the agent. A user cannot exfiltrate a credential through it, because no credential is there. |
| FR-TERM-070 | SHOULD | Several named terminals can be open against one session.                                                                                          |

## FR-PREV — Previews

| ID          | Level  | Requirement                                                                                                                                                                     |
| ----------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-PREV-010 | MUST   | A session can start the project's dev server in its container as a background process, surviving the request that started it.                                                   |
| FR-PREV-020 | MUST   | The preview is served on a **dedicated hostname per session**, on a preview domain distinct from the Codeflare application domain. Path-prefix previews on the app origin are forbidden. |
| FR-PREV-030 | MUST   | Preview requests are proxied through the Worker to the container port. The container exposes no public port.                                                                    |
| FR-PREV-040 | MUST   | The preview proxy supports WebSocket upgrade, so HMR and dev-server websockets work.                                                                                            |
| FR-PREV-050 | MUST   | Preview hostnames are protected by Cloudflare Access with the same team policy. A preview is not publicly reachable by default.                                                  |
| FR-PREV-060 | MUST   | The Codeflare session cookie is scoped so it is never sent to a preview hostname.                                                                                                   |
| FR-PREV-070 | MUST   | The UI shows dev-server status (starting, ready, crashed, stopped) and the tail of its log, and lets the user restart it.                                                        |
| FR-PREV-080 | SHOULD | A preview can be shared with a named individual by adding them to that preview's Access policy, with an expiry.                                                                 |
| FR-PREV-090 | MUST   | Stopping or archiving a session tears down its preview hostname, DNS binding, and Access entry.                                                                                  |

## FR-GIT — Git, branches, and publishing

| ID         | Level  | Requirement                                                                                                                                                                          |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-GIT-010 | MUST   | Each project is backed by one Artifacts repository. Each session works on its own branch in that repository.                                                                         |
| FR-GIT-020 | MUST   | A session container clones its branch from Artifacts using a short-lived, repo-scoped token that is never written into `.git/config` in plaintext.                                   |
| FR-GIT-030 | MUST   | The agent commits to the session branch. Commits are attributed to the agent with the initiating human recorded in the trailer.                                                      |
| FR-GIT-040 | MUST   | The session pushes its branch to Artifacts at each commit, so work is durable independently of container state.                                                                      |
| FR-GIT-050 | MUST   | A user can view the diff of a session branch against its base branch.                                                                                                                |
| FR-GIT-060 | MUST   | Integration of a session branch into the base branch goes through a **merge queue** that serialises merges per project. Two sessions can never merge concurrently.                   |
| FR-GIT-070 | MUST   | A merge conflict is surfaced to the user with the conflicting files and hunks; the merge is rejected rather than resolved automatically.                                             |
| FR-GIT-080 | SHOULD | A conflicted merge can be handed back to the originating session as a task, so the agent rebases and resolves it.                                                                    |
| FR-GIT-090 | MUST   | A user can publish a branch to a configured external remote (GitHub or GitLab).                                                                                                      |
| FR-GIT-100 | MUST   | Publishing supports **git-over-HTTPS**, with the token held by the Worker and injected by an outbound handler.                                                                       |
| FR-GIT-110 | MUST   | Publishing supports **git-over-SSH**, with the private key held outside the sandbox, in Secrets Store or an equivalent, and never present in any container filesystem.               |
| FR-GIT-120 | MUST   | Publishing is explicit and human-initiated. An agent cannot publish to an external remote on its own.                                                                                |
| FR-GIT-130 | MUST   | Host key verification is enforced for SSH publishing against a pinned known-hosts entry. `StrictHostKeyChecking=no` is forbidden.                                                    |
| FR-GIT-140 | SHOULD | Publishing reports the resulting remote branch URL so a user can open a pull request manually.                                                                                       |

## FR-OPS — Operations, cost, observability

| ID         | Level  | Requirement                                                                                                                                                            |
| ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-OPS-010 | MUST   | Every session container has an inactivity timeout. It is re-established by the Durable Object constructor when a restarted DO finds its container running.            |
| FR-OPS-020 | MUST   | Before a container sleeps, the session snapshots its filesystem and stores the snapshot handle in Durable Object storage.                                              |
| FR-OPS-030 | MUST   | Waking a sleeping session restores from its snapshot. A restore failure is reported as a clear error and never silently starts an empty workspace.                     |
| FR-OPS-040 | MUST   | Long-running work is kept alive by a Durable Object alarm that fires more frequently than the inactivity timeout and checks for outstanding work.                      |
| FR-OPS-050 | MUST   | Each session has a budget in model spend and container runtime. Exceeding it suspends the session and notifies the user; it does not silently continue.                |
| FR-OPS-060 | MUST   | The UI shows, per session, the elapsed container runtime and accumulated model spend.                                                                                  |
| FR-OPS-070 | MUST   | Structured logs carry a correlation identifier linking a user action to its Worker request, Durable Object invocation, container command, and model call.              |
| FR-OPS-080 | MUST   | Worker tracing is enabled, with custom spans for agent turns, tool calls, container starts, and git operations.                                                        |
| FR-OPS-090 | MUST   | Snapshots older than the retention window are pruned, and orphaned Artifacts repositories are reaped, by a scheduled job.                                              |
| FR-OPS-100 | SHOULD | An admin dashboard lists every running container in the account with its session, age, and cost.                                                                       |
| FR-OPS-110 | MUST   | `pnpm teardown` removes every resource the demo created, in an order that does not leave bindings attached to deleted resources.                                       |

---

## Non-functional requirements

| ID          | Level  | Requirement                                                                                                                                                                        |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NFR-PERF-010 | MUST   | A warm session (container running) accepts a chat message and begins streaming within 2 seconds at p95.                                                                           |
| NFR-PERF-020 | MUST   | A cold session (container stopped, snapshot present) is interactive within 30 seconds at p95.                                                                                     |
| NFR-PERF-030 | MUST   | Reconnecting to a live session renders full state within 3 seconds at p95.                                                                                                        |
| NFR-PERF-040 | MUST   | Terminal keystroke-to-echo latency is under 250 ms at p95 for a user in the same continent.                                                                                       |
| NFR-PERF-050 | SHOULD | Opening a file under 256 KiB in the editor completes within 1 second at p95.                                                                                                      |
| NFR-SEC-010  | MUST   | No model, git, or cloud credential is ever present in any container filesystem, environment variable, process argument, or git config. Verified by an automated test.             |
| NFR-SEC-020  | MUST   | A container starts with `enableInternet: false`. Every allowed destination is an explicit entry in an outbound handler.                                                           |
| NFR-SEC-030  | MUST   | A preview origin can neither read a Codeflare session cookie nor call a Codeflare control-plane API on the user's behalf.                                                                 |
| NFR-SEC-040  | MUST   | Errors are returned as RFC 9457 `application/problem+json`. No stack trace, internal path, or binding name leaks from a deployed build.                                           |
| NFR-SEC-050  | MUST   | Every secret is held in Secrets Store or Worker secrets. No secret appears in a config file, a command line argument, a log line, or the repository.                              |
| NFR-REL-010  | MUST   | A Worker deployment does not lose in-flight agent work. Turns resume or fail cleanly; containers keep running.                                                                    |
| NFR-REL-020  | MUST   | Losing a container mid-task leaves the session recoverable: the branch is intact in Artifacts up to the last push, and the failure is reported.                                   |
| NFR-REL-030  | MUST   | Every external call — model, Artifacts, GitHub/GitLab — has a timeout and a bounded retry with jittered backoff.                                                                  |
| NFR-COST-010 | MUST   | An idle session costs nothing beyond Durable Object storage. No container runs without an active session or outstanding work.                                                     |
| NFR-COST-020 | MUST   | Container instance size is chosen per session from a bounded set. A session cannot request an unbounded instance.                                                                 |
| NFR-A11Y-010 | MUST   | The UI meets WCAG 2.2 Level AA: keyboard operability, focus management, contrast, labels, landmarks.                                                                             |
| NFR-A11Y-020 | MUST   | Streaming agent output is announced to assistive technology without flooding it — a polite live region with coalesced updates.                                                    |
| NFR-DX-010   | MUST   | `pnpm start` gives a working local Codeflare from a clean clone with only the root `.env` configured.                                                                                 |
| NFR-DX-020   | MUST   | `pnpm check` and `pnpm test` pass offline and depend on no live infrastructure.                                                                                                   |
