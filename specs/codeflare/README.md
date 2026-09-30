# Codeflare — specification index

**Codeflare** is a web-based, multi-agent coding environment that runs on Cloudflare. A user opens a
browser, describes work in natural language, and one or more agents carry it out inside isolated
Linux sandboxes against real git branches. The user can close the tab; the work keeps running. When
they come back, the conversation, the terminal, the file tree and the running dev server are all
still there.

It is the Cloudflare-native answer to the "Code" surface Microsoft announced in
[Introducing the new Copilot with Home, Code and Autopilot](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/)
(25 Sep 2026): a sandboxed, tenant-hosted agentic coding runtime, reachable from the web,
disconnectable and reconnectable, running several agents concurrently and coordinating them with
git branches and worktrees.

Working name is `Codeflare`. It is used throughout as the product name, the family directory name
(`codeflare/`), and the hostname prefix. Renaming is a find-and-replace; nothing in the design depends
on it.

---

## How a swarm should consume this specification

Read in this order. Documents 00–05 are **binding context for every agent**. Documents 06–12 are
the per-area designs. Document 13 is the work breakdown that assigns those areas to parallel
packages.

| #                                             | Document               | Read it when                                              |
| --------------------------------------------- | ---------------------- | --------------------------------------------------------- |
| [00](./00-product.md)                         | Product and scope      | Always. Defines what is and is not being built.           |
| [01](./01-requirements.md)                    | Requirements           | Always. Every FR/NFR is numbered and testable.            |
| [02](./02-architecture.md)                    | Architecture           | Always. Tier boundaries and the Durable Object topology.  |
| [03](./03-domain-model.md)                    | Domain model           | Always. Entities, state machines, invariants.             |
| [04](./04-platform-notes.md)                  | Platform notes         | Always. Verified platform behaviour and its sharp edges.  |
| [05](./05-security.md)                        | Security               | Always. Access, egress, credentials, threat model.        |
| [06](./06-agent-runtime.md)                   | Agent runtime          | Building the agent loop, tools, or sub-agents.            |
| [07](./07-workspace-and-git.md)               | Workspace and git      | Building storage, branching, or publishing.               |
| [08](./08-previews.md)                        | Previews               | Building the preview proxy or dev-server lifecycle.       |
| [09](./09-frontend.md)                        | Frontend               | Building any UI.                                          |
| [10](./10-api-contracts.md)                   | API contracts          | Building anything that crosses a process boundary.        |
| [11](./11-operations.md)                      | Operations             | Building lifecycle, cost control, or observability.       |
| [12](./12-testing.md)                         | Testing                | Always, before you claim a package is done.               |
| [13](./13-work-breakdown.md)                  | Work breakdown         | Picking up a package. Start here after 00–05.             |
| [14](./14-risks.md)                           | Risks and open questions | Before making an irreversible design choice.             |

### Rules that override everything else

1. The repository-root [`AGENTS.md`](../../AGENTS.md) governs all code. Four tiers, `cf` CLI only
   (**never Wrangler**), pnpm, Oxfmt/Oxlint, `@adrianhall/cloudflare-toolkit`, RFC 9457 errors,
   complete JSDoc, the five required scripts. Codeflare adds `codeflare/AGENTS.md` for family rules; it
   supplements, never contradicts, the root file.
2. [`04-platform-notes.md`](./04-platform-notes.md) records behaviour that was verified against
   Cloudflare documentation on 30 Sep 2026. If your implementation disagrees with it, the
   documentation wins — but say so in your package notes, because several of these products are in
   beta and move.
3. A contract in [`10-api-contracts.md`](./10-api-contracts.md) is frozen. If you need to change
   one, raise it rather than changing it unilaterally: other packages are coding against it in
   parallel.
4. Anything marked **MUST** in a requirement is a gate on Definition of Done. Anything marked
   **SHOULD** may be deferred to a later milestone with a recorded reason.

### Decisions already made

These were settled before the specification was written. Do not relitigate them inside a package.

| Decision                | Choice                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Tenancy                 | Single-tenant, team-scoped. One deployment per team, users authenticated by Cloudflare Access. |
| Home                    | New family directory `codeflare/` in this repository, under full `AGENTS.md` compliance.          |
| Git storage             | Cloudflare Artifacts is the working store. GitHub/GitLab is the publish target.               |
| Frontend framework      | vinext (App Router) on Workers, matching the `vinext-demos` family conventions.               |
| Agent harness           | `@cloudflare/think` from the Agents SDK.                                                       |
| Execution environment   | Cloudflare Containers with the `durable_object` scheduling policy.                             |
