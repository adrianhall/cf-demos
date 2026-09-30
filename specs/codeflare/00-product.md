# 00 — Product and scope

## 1. The problem

A developer who wants an agent to do real work today has a bad set of choices.

Running an agent locally ties the work to one machine. Close the laptop and the agent stops.
Running several agents at once means several checkouts, several terminals, and manual reconciliation
of who changed what. And the agent runs with the developer's own credentials, on the developer's own
filesystem, with the developer's own network access — so "let the agent run unattended" is a
security decision most people are unwilling to make.

Hosted agentic coding environments solve the first problem and create a second: the work, the
source, and the credentials now live in somebody else's tenant.

Codeflare is the third option. The agents run in isolated Linux microVMs inside **your** Cloudflare
account. The source lives in **your** Artifacts namespace. The model credentials never enter the
sandbox at all. And because every session is a Durable Object, closing the browser is just a
disconnect — the session keeps working and you reattach to it later.

## 2. What Codeflare is

A web application with three things behind it:

- **A durable session.** Each unit of work is a Durable Object holding the conversation, the task
  state and the handle to a container. It survives browser disconnection, Worker deployment, and
  container sleep.
- **An isolated computer.** Each session owns a Linux container with a real filesystem, a real
  package manager, a real dev server and a real git client. Snapshots carry the filesystem across
  container restarts.
- **A coordinated swarm.** A project can run many sessions at once, each on its own branch,
  each in its own container. A merge queue serialises integration so concurrent agents do not
  corrupt each other's work.

The user-visible surface is four panes: a chat, a file tree with a Monaco editor, an xterm.js
terminal, and a live preview of the web app being built.

## 3. Primary user and use case

The primary user is a **professional web developer working in a small team** who wants to delegate
well-specified work to agents and review the result. The canonical project is a web application —
React/Next.js/vinext, Astro, Vue, or a plain Vite app — with a package.json, a dev server, and a
test suite.

The canonical session:

1. Point Codeflare at a GitHub or GitLab repository. Codeflare imports it into Artifacts.
2. Describe three independent pieces of work. Codeflare starts three agent sessions, each on its own
   branch, each in its own container.
3. Watch one of them: read the chat, scroll the terminal, open a file the agent just changed, click
   through the live preview of its dev server.
4. Close the laptop. Come back an hour later. All three are further along; two are finished.
5. Review the diffs. Merge the two good ones through the merge queue; send the third back with a
   correction.
6. Publish the merged branch to GitHub, over HTTPS or SSH, as a real branch that a human can open a
   pull request from.

## 4. Product principles

These resolve design arguments. When two approaches are both defensible, pick the one that better
satisfies the earlier principle.

1. **Credentials never enter the sandbox.** Every outbound request from a container is intercepted
   by a Worker that adds the credential. This is not a hardening measure added later; it is the
   shape of the system. See [05-security.md](./05-security.md).
2. **Disconnection is normal.** Every interactive surface reconnects and resynchronises. The
   question is never "what happens if the user disconnects" but "how fast do they get their state
   back".
3. **The session owns its computer.** Container lifecycle is decided by the session Durable Object,
   not by central configuration. This is what the `durable_object` scheduling policy is for.
4. **Isolation is per session, not per user.** The sandbox is the unit of trust. Two sessions
   belonging to the same user still get separate containers, because a compromised dependency in
   one task must not reach another task's working tree.
5. **Git is the coordination primitive.** Agents coordinate through branches and a merge queue, not
   through shared filesystem state or a lock server. If two agents disagree, it surfaces as a merge
   conflict, which is a problem developers already know how to solve.
6. **Cost is visible and bounded.** Containers are billed while running. Every session has an idle
   timeout, a budget, and a visible cost. An agent cannot run up an unbounded bill.
7. **Previews are a separate origin.** A preview runs code the agent wrote. It never shares an
   origin with the Codeflare control plane. This is non-negotiable.

## 5. In scope

| Area           | Included                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------- |
| Projects       | Import from GitHub/GitLab over HTTPS; create empty; fork a template.                          |
| Sessions       | Many concurrent per project; branch per session; durable chat; reattach after disconnect.     |
| Agents         | A `@cloudflare/think` harness with file, shell, git, test and preview tools. Background sub-agents. |
| Workspace      | Monaco file tree and editor, read and write, agent and human edits reconciled.                |
| Terminal       | xterm.js over WebSocket to a tmux session in the container.                                   |
| Previews       | Per-session dev server on its own hostname, Access-protected, with HMR/WebSocket support.     |
| Git            | Branch, commit, diff, merge queue, conflict surfacing.                                        |
| Publishing     | Push to GitHub and GitLab over HTTPS **and** git-over-SSH.                                    |
| Access control | Cloudflare Access at the edge plus in-application JWT validation and identity checks.         |
| Operations     | Idle sleep, snapshot/restore, budgets, cost display, structured logs and traces.              |

## 6. Out of scope for v1

Recorded so that no package invents them.

- **Non-web project types.** Mobile, embedded, data-science notebooks. The dev-server and preview
  model assumes an HTTP server on a port.
- **Real-time multi-user co-editing.** Two humans typing in the same file at once. Sessions are
  single-driver; a second human can watch, not type. Deferred, not rejected.
- **Native pull-request integration.** Codeflare pushes branches. It does not open, review, or merge
  pull requests on GitHub/GitLab. (FR-GIT-090 leaves the hook in place.)
- **Self-service tenant signup.** Single-tenant by decision. Onboarding is "an admin deploys it and
  adds people to an Access group".
- **A marketplace of agent skills.** Agent Skills are used internally; there is no publishing or
  sharing surface.
- **Desktop/computer-use automation.** No VNC, no GUI driving. The Sandbox SDK removed its desktop
  feature; Codeflare does not reintroduce it.
- **Arbitrary long-lived background services.** A session runs a dev server and a test runner. It is
  not a hosting platform for the app under construction. Deployment of the finished app is the
  user's job, through `cf deploy` from their own machine or CI.

## 7. Milestones

Each milestone is independently demonstrable. A swarm should not begin M2 packages that depend on
unfinished M1 contracts, but may begin M2 packages that do not.

### M1 — One session, one agent, end to end

An authenticated user imports a repository, starts one session, chats with an agent that edits
files and runs commands, sees the file tree and terminal, and views a live preview. Closing the
browser and returning restores everything.

Gate: FR-AUTH-\*, FR-PROJ-010/020, FR-SESS-\*, FR-AGENT-010..060, FR-WS-\*, FR-TERM-\*,
FR-PREV-010..040, FR-GIT-010..040.

### M2 — Many agents, coordinated

Several sessions run concurrently on separate branches. Diffs are reviewable. The merge queue
integrates finished work and surfaces conflicts.

Gate: FR-PROJ-030, FR-SESS-070, FR-GIT-050..080, FR-AGENT-070/080.

### M3 — Publish and operate

Branches publish to GitHub and GitLab over HTTPS and SSH. Sessions sleep, snapshot, restore.
Budgets are enforced and cost is visible. Observability is complete.

Gate: FR-GIT-090..120, FR-OPS-\*, all NFRs.

## 8. What "done" looks like

Beyond the root `AGENTS.md` Definition of Done:

1. Every numbered requirement in [01-requirements.md](./01-requirements.md) marked MUST is
   implemented and covered by a test named after it.
2. `pnpm check` and `pnpm test` pass at the repository root.
3. `pnpm deploy` followed by `pnpm teardown` leaves the Cloudflare account clean — no orphan
   containers, Artifacts repos, Access applications, DNS records, or Durable Object namespaces.
4. A cold reviewer can follow `codeflare/README.md` from a fresh clone, with only the root `.env`
   configured, and reach a working session.
5. The security checklist in [05-security.md §9](./05-security.md) is signed off line by line.
