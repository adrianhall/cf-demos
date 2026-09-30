# 04 — Platform notes

Behaviour verified against Cloudflare documentation on **30 September 2026**. Several of these
products are in beta and will move. If the documentation disagrees with a note here, the
documentation wins — but record the divergence in your package notes so the specification can be
corrected.

This document exists because most of the hard bugs in a system like Codeflare come from these details,
not from the application logic.

---

## 1. Containers with the `durable_object` scheduling policy

**Status:** public beta. **This is the policy Codeflare uses.** It is what makes per-session containers
possible.

### Configuration

```jsonc
{
  "containers": [
    {
      "class_name": "SessionDO",
      "scheduling_policy": "durable_object",
      "images": {
        "session": { "dockerfile": "./container/Dockerfile" }
      }
    }
  ],
  "durable_objects": { "bindings": [{ "name": "SESSION", "class_name": "SessionDO" }] },
  "exports": { "SessionDO": { "type": "durable-object", "storage": "sqlite" } }
}
```

Wrangler/`cf` builds each named image and exposes a digest-pinned reference on
`ctx.container.images.<name>`.

### Starting a container

```ts
this.ctx.container.start({
  image: this.ctx.container.images.session,
  instance: 'standard-2',
  enableInternet: false,
});
```

### Things that will catch you

| Behaviour                                                                     | Consequence for Codeflare                                                                                      |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| The policy is **immutable**. Changing it means a new container application.    | Choose `durable_object` at the start. Switching later destroys every running instance.                      |
| `max_instances` is not supported under this policy.                            | Concurrency is bounded in the application. Running instances count against account limits.                  |
| `start()` returns **before** the container is ready.                           | Every start path needs an explicit readiness poll. There is no "started" event to await.                     |
| `start()` **throws** while an instance is already running.                      | Always check `ctx.container.running` first. To change image or options, `destroy()` then start again.        |
| A running instance keeps the image and options it started with.                | A deploy does not migrate a running session to a new image. New images apply to instances started after.     |
| The Cloudflare-managed image `cloudflare/debian-trixie` (Node 24.20.0) can be started with no named-image config. | Useful for a fallback or a smoke test. Not rich enough for a real project image.            |
| Custom instance types no longer have a disk-to-memory ratio limit (as of 29 Sep 2026). | Up to 20 GB disk on any custom type. Useful for large `node_modules`.                              |
| `exec()` requires the container to be already running.                         | `exec()` on a stopped container is an error, not an implicit start.                                          |
| `exec()` takes an argv array and runs it directly — **no implicit shell**.      | Pipes, redirects, and variable expansion need an explicit `bash -lc`.                                        |

### Instance types

| Type         | vCPU | Memory  | Disk  |
| ------------ | ---- | ------- | ----- |
| `lite`       | 1/16 | 256 MiB | 2 GB  |
| `basic`      | 1/4  | 1 GiB   | 4 GB  |
| `standard-1` | 1/2  | 4 GiB   | 8 GB  |
| `standard-2` | 1    | 6 GiB   | 12 GB |
| `standard-3` | 2    | 8 GiB   | 16 GB |
| `standard-4` | 4    | 12 GiB  | 20 GB |

Custom types: min 1 vCPU, max 4 vCPU, max 12 GiB memory, max 20 GB disk, minimum 3 GiB memory per
vCPU. **Codeflare default is `standard-2`** — 1 vCPU and 6 GiB is enough for an install plus a dev
server, and it is the first tier with a full vCPU.

### Account limits

6 TiB concurrent memory, 1,500 concurrent vCPU, 30 TB concurrent disk, 50 GB total image storage.
With `standard-2` at 6 GiB, the memory ceiling permits roughly a thousand concurrent sessions. The
50 GB image-storage limit is the real constraint on how many project images can coexist — keep the
image set small and prune old ones.

---

## 2. Container lifetime — the trap that will cost you a day

This is the highest-value section in this document. Read it twice.

### What keeps an instance alive

An instance runs while its Durable Object is *active*: handling a request, running an alarm,
streaming a response, or holding an accepted WebSocket open. After the DO goes inactive, the
instance survives for the period set by `setInactivityTimeout()`, up to **6 hours**.

### Code running inside the container is not activity

> If no requests arrive, the instance stops when the inactivity timeout ends, **even while a build,
> a test suite, or an agent task is still running inside it**.

This is the trap. A 20-minute `pnpm install` plus test run, with no inbound requests, will be
killed mid-flight.

**The fix, and it is mandatory (FR-OPS-040):** a Durable Object alarm that fires *more often than
the inactivity timeout*, checks whether work is outstanding, and re-arms itself. Codeflare uses a
60-second alarm while any of these is true: an agent turn is in flight, a background process is
alive, a dev server is running, or a terminal is attached.

### The timeout does not survive a Durable Object restart

A DO can restart — after a deploy, or between alarms — while its container keeps running. The
restarted DO has **no inactivity timeout**, so the container dies shortly after it next goes idle.

**The fix, also mandatory:**

```ts
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  const container = ctx.container;
  if (container?.running) {
    void ctx.blockConcurrencyWhile(() =>
      container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
    );
  }
}
```

Every Codeflare Durable Object class with a container **must** have this constructor. It is not
optional and it is not an optimisation.

### What stops an instance

1. The inactivity timeout elapses — `SIGTERM` to every process, then a hard stop shortly after.
2. `destroy()` — immediate, no cleanup window.
3. **The main process exits.** The entrypoint, or the image's default command.

Point 3 is why the image ends in `CMD ["sleep", "infinity"]`. `cloudflare/debian-trixie`'s default
command exits immediately, so starting it without an entrypoint override gives a container that
dies at once.

Use `SIGTERM` only for cleanup that is allowed to fail. Save anything that matters before the
instance stops.

### Deploys

A deploy restarts every Durable Object. Running instances keep running and the next request reaches
the same instance with its files and processes intact. Outbound handlers registered with
`interceptOutboundHttp()` stay in place and start running the new version's code.

But: in-flight requests, streamed responses, and WebSockets end. **A browser terminal disconnects
on every deploy and must reconnect.** Build for that.

### `monitor()`

A pending `monitor()` call keeps the Durable Object in memory, so the inactivity timeout only starts
after the DO leaves memory — at which point the call ends and therefore does not report the stop
that follows. Do not rely on `monitor()` to detect container termination. Use the documented
stop-detection pattern instead.

---

## 3. Snapshots

**Status:** public beta. Supported **only** under the `durable_object` scheduling policy.

```ts
const snapshot = await this.ctx.container.snapshotContainer({ name: 'workspace' });
await this.ctx.storage.put('snapshotId', snapshot.id);
await this.ctx.container.destroy();

// later
this.ctx.container.start({
  containerSnapshot: { id: snapshotId },
  entrypoint: ['sleep', 'infinity'],
  enableInternet: false,
});
```

| Property                                                                  | Consequence                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Captures the writable root filesystem. **Not** memory, **not** processes. | A restored session has files but no dev server. Restart it explicitly.          |
| Immutable.                                                                | Every save is a new snapshot. Store the newest ID and prune the old.            |
| Tied to the image version it was made from; **not portable across images**. | Changing a project's image invalidates its snapshots. Plan a re-clone path.    |
| Does **not** include mounted directories.                                  | R2 mounts survive independently — you can combine both deliberately.            |
| Max 20 GB.                                                                 | With `node_modules` a big project can approach this. Consider excluding it.     |
| 30-day TTL, refreshed on restore.                                          | An untouched archived session loses its snapshot after 30 days. Branch survives in Artifacts. |
| A missing snapshot is a hard error on restore.                             | Fail loudly (FR-OPS-030). Never silently start empty.                           |

The handle is a plain data object, so it can be stored and even handed to another Durable Object.

---

## 4. Outbound traffic and credential injection

The mechanism behind NFR-SEC-010 and the single most important security property of Codeflare.

### The rule

A container started with `enableInternet: false` reaches only what an outbound handler intercepts.
Handlers see **HTTP on port 80 and HTTPS on port 443 only**.

> Keep Internet access off when you use an outbound handler. With Internet access on, connections
> to other ports go out directly.

So `enableInternet: true` plus an allowlist is **not** equivalent to `false` plus a handler. Only
the latter is a closed door. Codeflare always uses the latter.

### Credential injection

Outbound handlers run in the Workers runtime, outside the container. They hold secrets the container
never sees:

```ts
export class GitGateway extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const repository = `/${this.env.REPOSITORY}.git`;
    const fetchesRepository =
      (request.method === 'GET' &&
        url.pathname === `${repository}/info/refs` &&
        url.search === '?service=git-upload-pack') ||
      (request.method === 'POST' && url.pathname === `${repository}/git-upload-pack`);

    if (url.hostname !== 'github.com' || !fetchesRepository) {
      return new Response('Forbidden', { status: 403 });
    }

    const headers = new Headers(request.headers);
    headers.set('Authorization', `Basic ${btoa(`x-access-token:${this.env.GITHUB_TOKEN}`)}`);
    return fetch(new Request(request, { headers }));
  }
}
```

Note what this does beyond adding a header: it pins the **repository**, the **method**, and the
**path**. `git-upload-pack` serves clones and fetches; `git-receive-pack` serves pushes. By
allowing only the former, code in the sandbox cannot push — *even though the token would permit it*.
Codeflare applies exactly this pattern: read-only interception for the agent, and a separate
human-initiated path for publishing.

Only add a credential to an **HTTPS** request. The handler fetches with whatever scheme the
container used, so a credential added to a plain HTTP request crosses the Internet in clear text.

### Why not put the token in the clone URL

Because `git` writes it to `.git/config`, where every test, build script, and transitive dependency
in the container can read it. The documentation spells this out. Codeflare never does it.

---

## 5. Previews

### Reaching a container port

```ts
url.protocol = 'http:';                       // getTcpPort().fetch() rejects https:
const response = await container.getTcpPort(port).fetch(new Request(url, request));
```

The dev server **must** listen on `0.0.0.0`. `getTcpPort()` cannot reach a server bound only to
`127.0.0.1`, and most dev servers default to localhost.

### Per-session hostnames — required, not preferred

The documentation is unambiguous:

> A web preview carries more risk, because it runs in the visitor's browser. On your application
> hostname, the page can use your application cookies and call its APIs. Serve previews on a
> separate hostname to keep the page away from both.

Setup:

1. A proxied wildcard DNS record on the preview zone — an `AAAA` record, name `*`, content `100::`,
   proxy status **Proxied**. Cloudflare never contacts that address; the Worker route intercepts.
2. A Worker route `*.preview.example.com/*` with `zone_name` set.
3. `workers_dev: true` retained, because setting `routes` otherwise disables the `workers.dev`
   hostname used for control-plane calls.
4. Validate the extracted label against `/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/` and 404 anything
   else.

And the operational rule: every request to a preview hostname goes to the preview. Keep
preview-management routes on other hostnames, so code in a preview cannot call them from its own
origin.

### Deployed-only gotchas

- The container hostname is longer than a DNS label. Servers that look up their own hostname —
  notably Python's `http.server` — exit on startup *after deployment* while working locally.
- Forward a request **once**. A retry could replay a `POST`.

---

## 6. Artifacts

**Status:** closed beta. Access is confirmed for this project.

### Shape

A namespace contains repositories. Each repository is an isolated git service with its own history,
refs, remote, and tokens. Three interfaces onto the same repository:

| Interface       | Auth                                        | Use for                                       |
| --------------- | ------------------------------------------- | --------------------------------------------- |
| Workers binding | The configured binding, no token in code    | Create, get, list, import, fork, delete, mint tokens |
| REST API        | Cloudflare API token (Artifacts Read/Edit)  | The same, from outside a Worker               |
| Git protocol    | Repo-scoped Artifacts token                 | clone, fetch, pull, push                      |

Remote URL: `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`

### Tokens

Format `art_v1_<40 hex>?expires=<unix_seconds>`. Two ways to present them:

```sh
# Preferred: header, keeps the credential out of the URL and out of .git/config
git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" clone "$ARTIFACTS_REMOTE"

# Basic auth in the URL — only for short-lived one-off commands
https://x:<token-secret>@<ACCOUNT_ID>.artifacts.cloudflare.net/git/<ns>/<repo>.git
```

The `?expires=` suffix must be stripped when using the basic-auth form:
`token.split('?expires=')[0]`.

Scopes: `read` for clone/fetch/pull, `write` for push. Tokens are **repo-scoped** — a token for one
repo grants nothing on another, even in the same namespace.

### Guidance that maps directly onto Codeflare

- **A repo per unit of work.** "If you have 10,000 agents, create 10,000 repos." Codeflare chooses one
  repo per *project* with a branch per session, because sessions in a project must merge into a
  shared base. The documentation's warning — "do not use one shared repo as a queue for many
  autonomous agents" — is exactly why FR-GIT-060 mandates a serialised merge queue.
- **Fork from a stable baseline.** `baseline.fork(name, { defaultBranchOnly: true })` for templates.
- **Mint short-lived least-privilege tokens.** `repo.createToken('read', 900)` for a container
  clone; `write` only where a push is genuinely needed.
- **Unique names.** Include stable identifiers; a scheme like `${agent}-${session}-${repo}` avoids
  collisions and makes cleanup tractable.

### Limits

| Limit                      | Value                                         |
| -------------------------- | --------------------------------------------- |
| Control-plane requests     | 2,000 per 10 s per namespace                  |
| Git requests               | 2,000 per 10 s per repository                 |
| Storage per repository     | 10 GB                                         |
| Storage per account        | 1 TB (raisable on request)                    |
| Repositories, namespaces   | Unlimited                                     |
| Name charset               | Start with letter/digit; then letters, digits, `.`, `_`, `-` |

Jurisdictions (`eu`, `us`) are set at namespace creation and **cannot be changed**. Decide before
creating the Codeflare namespace.

### Events

Account-level, source `artifacts`: `repo.created`, `repo.deleted`, `repo.forked`, `repo.imported`.
Repository-level, source `artifacts.repo`: `pushed`, `cloned`, `fetched`.

`cf.artifacts.repo.pushed` carries `ref`, `before`, `after`, and `commits[]`. This is the natural
trigger for CI (see §10) and for a review agent.

### ArtifactFS

A FUSE mount that starts with a blobless clone and hydrates file contents on demand, prioritising
package manifests and common source files. Worth it for large repos where clone time dominates
session startup. For an ordinary web project, a plain `git clone` is simpler and fast enough.
**Treat ArtifactFS as an optimisation to measure, not a default.**

---

## 7. Cloudflare Access

### Protecting the application

Four destination types exist: `worker`, `preview_worker`, `all_workers`, `all_preview_workers`, plus
ordinary self-hosted hostname applications.

**Codeflare must use a hostname-based application.** This is not a preference:

> Worker-level Access policies do not currently support WebSocket connections. WebSocket upgrade
> requests to a Worker protected by a worker-level Access policy will fail with a `403` error. If
> your Worker uses WebSockets (including Durable Objects, real-time applications, …), protect it
> with a hostname-based Access application instead.

Codeflare is built on WebSockets for chat, terminal, and file events. Using the "protect this Worker"
toggle would break all three with a hard-to-diagnose 403.

So: one self-hosted application for `codeflare.example.com`, one for `*.preview.example.com`, both
against the same team policy, plus a bypass policy for the genuinely public routes.

### Defence in depth is mandatory

Root `AGENTS.md`: edge gating is not sufficient. Validate the Access JWT inside the application
**and** check the specific authorized identity — every Access application in a team shares a JWKS,
so a token minted for an unrelated application in the same team would otherwise be accepted.

Concretely: verify the signature against the team JWKS, verify `aud` equals *this* application's
AUD, then check project membership. Use the toolkit's Access middleware rather than writing this.

### Local development

Emulate, never disable. The toolkit's Access local-development Vite plugin injects the same headers
locally, so the local and deployed authorization paths are the same code. Per
`vinext-demos/AGENTS.md`, register `cloudflareAccessPlugin()` **before** `cloudflare()`.

---

## 8. The `cf` CLI

**Status:** beta (28 Sep 2026). **Wrangler is forbidden in this repository.**

| Capability                | Detail                                                                   |
| ------------------------- | ------------------------------------------------------------------------ |
| API coverage              | 2,900+ commands generated from the public API schemas; most print JSON.  |
| Project configuration     | `cloudflare.config.ts`, typed, so editors and agents autocomplete it.    |
| Project commands          | `cf init`, `cf dev`, `cf build`, `cf deploy`.                            |
| Migration                 | `cf migrate` converts a Wrangler config.                                 |
| Agent affordance          | `cf cli search` finds a command from a plain-language description.       |
| Types                     | `cf workers types --mode development` — run it in `check:types`.         |

Configuration, build output, and command surface can change before stable. Pin the `cf` version in
`package.json` and treat a `cf` upgrade as a deliberate change.

Note that container and Artifacts documentation is still written against Wrangler in places. Where a
snippet shows `wrangler.jsonc`, translate it into `cloudflare.config.ts`. Where it shows a
`wrangler artifacts …` command, find the `cf` equivalent with `cf cli search`. **Do not copy
Wrangler invocations into Codeflare.**

---

## 9. Agents SDK

`@cloudflare/think` 0.19.0 is the harness; `@cloudflare/ai-chat` 0.12.0 is the chat client; both
ship from the `cloudflare/agents` repository and are converging on one model.

Relevant capabilities:

| Capability            | Why Codeflare needs it                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Durable chat recovery | Turns ride through deploys, DO evictions, and stalled model streams. Directly satisfies FR-AGENT-070. |
| Stream-stall watchdog | Detects a model stream that has stopped producing and repairs the message history.                   |
| Background sub-agents | `runAgentTool(..., { detached: { onFinish, maxBudgetMs } })` with progress reporting and `cancelAgentTool(runId)`. FR-AGENT-080. |
| Container attachment  | Attaching a container to the agent's DO gives the agent a sandbox via `this.ctx.container`.           |
| `beforeTurn` gating   | Restrict `activeTools` per turn — used to hide workspace file tools when the shell tool should be used. |
| Lifecycle hooks       | `beforeToolCall` / `afterToolCall` are where approval gating (FR-AGENT-100) and audit logging attach. |
| Agent Skills          | On-demand instructions loaded from a local `./skills` directory or R2, so a large capability library does not bloat every prompt. |
| Actions               | Server-side tools with idempotency and human approval built in.                                      |

Background sub-agents default to a 24-hour `maxBudgetMs` ceiling. Codeflare sets a much lower one,
derived from the session budget.

---

## 10. Other platform pieces worth knowing about

| Product / feature                 | Relevance to Codeflare                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Worker Previews**               | Per-branch isolated environments. DO namespaces and container apps are auto-provisioned per Preview; KV/D1/R2 need separate bindings. Use for Codeflare's **own** CI, not for user previews. |
| **`@cloudflare/ci`**              | `ci.runner()` steps in sandboxes with lockfile-keyed caching, triggered by `cf.artifacts.repo.pushed`. The natural way to run a user project's tests on push without occupying the session container. |
| **`@cloudflare/computer`**        | SQLite-backed VFS in a DO, with container (FUSE), isolate-shell (just-bash), and isolate-JS backends. **Preview only, explicitly not production-ready.** Its ~10 GB workspace limit and FUSE I/O cost rule it out for `node_modules`. Interesting for lightweight file tools; not the Codeflare execution model. |
| **Dynamic Workers / Code Mode**   | Faster than a container for code that only calls methods you define. Right for small structured transforms; wrong for `pnpm install`. |
| **Browser Run**                   | CCDP-driven browser automation. The obvious way to let an agent verify its own UI work. Post-v1. |
| **Cloudflare Tunnel in sandboxes**| Quick tunnels on `*.trycloudflare.com`, or named tunnels bound to a zone hostname. An alternative to Worker-proxied previews — rejected for Codeflare because the Worker proxy keeps Access in the path. |
| **Workers tracing**               | `startActiveSpan()`, `span.end()`, `getActiveSpan()`, `recordException()`, `setAttributes()`. DO and subrequest spans are automatic; JS RPC session spans are included. FR-OPS-080. |
| **Secrets Store**                 | Account-level encrypted secrets, bound by `store_id` + `secret_name`. Where the GitHub/GitLab tokens and the SSH key live. |
| **`ctx.exports`**                 | Default from compatibility date 2025-11-17. Preferred over `env` bindings for DO access; gives automatic Preview isolation. |
| **Declarative `exports`**         | Replaces the imperative `migrations` array for DO class lifecycle. `exports` and `migrations` are mutually exclusive in one Worker. Codeflare uses `exports`. |
| **New DO namespaces**             | Must use the SQLite storage backend (since 9 Jul 2026). Not a choice.                                 |
| **Node.js compatibility**         | Enabled by default since 4 Aug 2026.                                                                  |
| **`@cloudflare/vitest-plugin`**   | Renamed from `@cloudflare/vitest-pool-workers` (19 Aug 2026). Use the new name. Provides `readD1Migrations()` and DO-eviction test helpers. |
| **AI Gateway**                    | Unified model access and billing, spend limits, identity-aware controls, User Insights for overuse. All model traffic goes through it. |
| **FUSE in local dev**             | Miniflare grants local containers FUSE privileges automatically on macOS/WSL and rootless Linux Docker. Rootful Docker on Linux does not support it. |
| **Container SSH**                 | Enabled by default, reachable only through the CLI, and requires a public key in `authorized_keys`. A debugging affordance for operators; **not** a user-facing feature. |

---

## 11. Costs

Container billing runs per 10 ms of active running time, on the Workers Paid plan:

| Dimension | Included per month | Overage                       |
| --------- | ------------------ | ----------------------------- |
| Memory    | 25 GiB-hours       | $0.0000025 per GiB-second     |
| CPU       | 375 vCPU-minutes   | $0.000020 per vCPU-second     |
| Disk      | 200 GB-hours       | $0.00000007 per GB-second     |

Memory and disk are billed on **provisioned** resources; CPU on **active** use. Charges start when
a request arrives or the container is manually started, and stop when it sleeps.

The arithmetic that shapes Codeflare's design: a `standard-2` instance provisions 6 GiB, so the included
25 GiB-hours is roughly **four instance-hours per month**. A session left running all day is
material money. Hence NFR-COST-010, aggressive idle sleep, and visible per-session cost.

Egress: $0.025/GB in North America and Europe with 1 TB included; $0.04–0.05/GB elsewhere with
500 GB included.

Workers, Durable Objects, and Workers Logs are billed separately at their own rates.
