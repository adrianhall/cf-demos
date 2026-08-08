# Demo 10: OpenCode In Browser

Directory: `demos/opencode`

Domain: `opencode.cfapps.uk`

Status: Draft implementation plan — no code exists yet.

Cloudflare products: Workers, Static Assets, Cloudflare Access, D1, Workers KV,
Durable Objects, Containers, and Workers AI (reached through the same `AI`
binding demo 5 introduced, routed through AI Gateway for cost/analytics).

## Tech Stack And Hosting Services

**Hosting and platform services:**

- **Workers** — the single deployed unit: it serves the API, the built browser
  application (through `ASSETS`), and every proxied byte between the browser
  and a workspace's container. Custom domain `opencode.cfapps.uk`.
- **Static Assets** (`ASSETS` binding) — hosts the built Vue SPA under a
  reserved `/_app/` path prefix only (see "Routing" below) — not at the
  document root, which is the one deliberate deviation from every prior
  demo's asset layout, and exists solely to leave the root free for proxied
  workspace traffic.
- **Cloudflare Access** — one self-hosted application gating the whole
  hostname, following `demos/ai-chat` and `demos/chat` (compute is billable
  here too — containers, not just inference).
- **D1** — the workspace registry (owner, repository, provider, status) and
  the egress log. Reused from demo 2/3, not reintroduced.
- **Workers KV** — short-lived, per-workspace secrets (a git credential and
  the container's own local admin password), keyed by workspace ID. Reused
  from demo 1's lesson, applied here as the credential store the platform's
  own outbound handlers read — never the application data store KV was
  originally introduced for.
- **Durable Objects** — one `Workspace` instance per workspace, extending
  `Container`. Demo 4 introduced Durable Objects generally; this demo's new
  angle is a Durable Object that **owns a container's lifecycle** rather than
  broadcasting WebSocket messages.
- **Containers** — the lesson this demo exists to teach. Each workspace gets
  its own container instance running a cloned repository and `opencode web`.
  This is a **beta** product; verify every API surface named below against
  current documentation before implementing (see "Containers Has No Local
  Simulation In CI" below).
- **Workers AI** (`AI` binding) + **AI Gateway** — the model backend `opencode`
  inside the container calls, bridged through the Worker so the container
  never holds a model-provider credential (see "Model Routing").
- **Workers Logs and automatic tracing** — the observability surface for
  provisioning, egress decisions, and model routing.

**Application stack:**

- TypeScript, **Hono** on the Worker; **Vue 3** + **Vuetify** + **Pinia** +
  **Vue Router** + **Feather Icons** in the browser; **Vite** with the
  Cloudflare Vite plugin builds both halves.
- `@cloudflare/containers` for the `Container` base class and its outbound
  interception API.
- `@adrianhall/cloudflare-toolkit` for `cloudflareLogger()`, RFC 9457 problem
  details, guards, `cloudflareAccess()` + `cloudflareAccessPlugin()`, testing
  helpers, and the `generate-wrangler` / `generate-wrangler-types` CLIs.
- **Terraform** (Cloudflare provider `~> 5.22.0`, `jrhouston/dotenv ~> 1.0`)
  for the Worker, bootstrap version/deployment, custom domain, D1 database, KV
  namespace, observability, and Access application/policy. **Wrangler** owns
  code versions, deployments, the container image build, and — like the
  Durable Object namespace/migrations pattern in `demos/chat` — the
  `containers` configuration itself.
- **Vitest** with three projects (`worker`, `client`, `integration`) and
  `@vitest/coverage-istanbul`. No Playwright. Container startup itself cannot
  run inside `@cloudflare/vitest-pool-workers` (see below) and is verified
  only by a documented manual smoke check, exactly as demo 5 treats real
  model inference.
- The **container image**: a small Debian-based Node.js 24 image with `git`,
  `ca-certificates`, and the `opencode-ai` npm package, running `opencode`'s
  own built-in **`opencode web`** server (see "Why `opencode web`, Not A
  Hand-Built Terminal" below).

**Deliberately absent**: Workflows, R2, Vectorize, the Agents SDK, and
Workers for Platforms. This demo is not the "Enterprise AI Vibe Coding
Platform" reference architecture — see "Out Of Scope."

## Why `opencode web`, Not A Hand-Built Terminal

The backlog's original phrasing — "user is presented with OpenCode in a
terminal connected to the container" — reads as a request to wire up
`xterm.js` and a PTY over a WebSocket. **Do not build that.** OpenCode ships
its own first-class browser interface: running `opencode web` inside a
directory starts a small local HTTP+WebSocket server with a complete
session-based UI (new/active sessions, streaming responses, file diffs) —
literally "OpenCode in a browser." Building a bespoke terminal emulator would
re-implement a product feature that already exists, worse, and would teach
nothing about Containers that proxying a real long-lived container process
does not already teach. This demo's job is to run that existing server inside
a Cloudflare Container, per workspace, reachable only through an
authenticated, owner-scoped Worker proxy — not to reinvent OpenCode's UI.

Verify `opencode web`'s exact CLI flags (`--hostname`, `--port`,
`OPENCODE_SERVER_PASSWORD`) against current OpenCode documentation before
Phase 3; the tool evolves independently of this repository.

## Behavior

- A signed-in user creates a **workspace** from a GitHub or GitLab repository
  URL (public, or private with a pasted fine-grained personal access token).
  Creating a workspace provisions a dedicated **Durable Object + Container**
  pair: the container clones the repository and starts `opencode web`
  inside it.
- The user opens the workspace and gets **OpenCode running in their browser**,
  proxied live from the container, alongside a sidebar showing the
  workspace's **egress log** — every outbound HTTP(S) request the container
  has attempted, whether it was allowed, denied, or had a credential injected,
  updated as it happens.
- The container is **configured for the logged-in user**: its Access identity
  determines workspace ownership, and its git operations are authenticated
  with a credential the container process never sees directly.
- The container's outbound network access is **default-deny beyond a small
  allowlist** (git hosts, package registries, the model bridge). A presenter
  can ask OpenCode to reach an unlisted host, watch it get denied and logged
  live in the sidebar, allow that host with one click, and watch the retry
  succeed — the demo's single clearest "observable platform behavior."
- OpenCode's model calls are **routed through Workers AI and AI Gateway**
  automatically, without the container ever holding a model-provider API key.
- Workspaces can be **stopped** (container sleeps, Durable Object state
  persists) and **deleted** (container destroyed, D1 row and KV secret
  removed) independently of the demo's own infrastructure teardown.

This is the curriculum's introduction to **Containers**: running a real,
stateful, long-lived OS process behind a Worker, with the Worker's Durable
Object as its control plane and its outbound traffic as a governed, logged
boundary rather than a raw firewall hole. Access, D1, KV, and Durable Objects
are reused from earlier demos; Workers AI and AI Gateway are reused from
demos 5 and 6's lesson, applied here as *infrastructure a container calls*
rather than a feature the browser calls directly.

## Explicit Exceptions

This demo intentionally narrows or extends the repository-wide baseline in
ways that would be wrong for most other demos:

- **Static Assets are not served at the document root.** Every other demo in
  this repository serves its Vue SPA at `/` with `not_found_handling:
  single-page-application`. This demo instead mounts the SPA under `/_app/`
  (via a Vite `base: "/_app/"` build option) and reserves `/` and every other
  unreserved path for proxying to the active workspace's container. See
  "Routing." This is a necessary consequence of embedding a *second*,
  independently-built single-page application (OpenCode's own) on the same
  origin; without a reserved prefix for our own app, the two SPAs' root-
  relative asset URLs (`/assets/*.js`) would collide.
- **No Terraform resource for `containers`.** Exactly like the Durable Object
  namespace/migrations pattern already established in `demos/chat`, the
  `containers` array, its `class_name`/`image`/`instance_type`, and the
  paired `durable_objects` binding and `new_sqlite_classes` migration are
  declared entirely in `wrangler.jsonc.tpl` and owned by Wrangler at deploy
  time (Wrangler builds and pushes the image). Say so explicitly beside the
  Worker resource in `infra/opencode.tf`, mirroring the comment style already
  used for `demos/chat`'s Durable Object namespace.
- **Local development requires a container engine.** This is the first demo
  in the repository that needs Docker Desktop or Colima installed locally
  (`vite dev` / `wrangler dev` build and run the container image). State this
  as a new prerequisite in `README.md`; no prior demo needed it.
- **Requires a Workers Paid plan.** Containers (beta, at time of writing) and
  sustained Durable Object usage are not available on the Workers Free plan.
  Verify the exact current plan requirement against documentation during
  Phase 1 and state it plainly in `README.md`'s prerequisites — do not let an
  operator discover this from a failed `terraform apply`.
- **A container-facing Worker route intercepts model calls locally instead of
  calling AI Gateway's external HTTPS endpoint.** See "Model Routing." This
  keeps the container's credential surface at zero, at the cost of an extra
  internal hop most Containers demos would not need.

## Out Of Scope

- **A hand-built terminal UI** (`xterm.js`, a PTY bridge). See "Why `opencode
  web`, Not A Hand-Built Terminal."
- **The full "Enterprise AI Vibe Coding Platform" reference architecture** —
  Workers for Platforms, DLP inspection, MCP server portals, Artifacts,
  per-tenant dispatch-worker isolation, and resource tagging. That is a
  capstone-scale reference design for productizing this idea across an
  organization; this demo teaches the one underlying primitive (Containers +
  Durable Objects + outbound interception) at curriculum scale. Link the
  reference architecture from `EXPLAIN-DEMO.md`'s further reading.
- **Concurrent workspaces in multiple browser tabs on one profile.** A
  browser can have exactly one *active* workspace at a time (an httpOnly
  cookie names it); opening a second workspace replaces the first. A
  presenter who needs two workspaces open side by side should use two
  browser profiles or an incognito window. This is a deliberate
  simplification — see "Routing" — not a platform limitation; a follow-on
  demo could lift it with per-workspace subdomains, noted as an alternative
  in `EXPLAIN-DEMO.md`.
- **`cc-safety-net` and a "skills-recommender" first-run process.** The
  backlog names both with "consider" language, not as requirements. Neither
  has a confirmed, publicly installable form as of this writing. Ship a
  small, conservative default `opencode.json` (see Phase 3) instead, and
  document adopting a real safety-net/skills-recommender project as future
  work once one exists in a verifiable, installable form.
- **GitHub/GitLab OAuth App integration.** Repository access uses a
  user-pasted fine-grained personal access token, not a platform-registered
  OAuth application. Building a GitHub/GitLab App is a substantial, separate
  integration effort that would not teach anything new about Containers.
- **Deep Sandbox SDK comparison.** This demo uses the `@cloudflare/containers`
  `Container` class directly, not the Sandbox SDK. `docs/06-AGENTIC-CHAT.md`
  already distinguishes Dynamic Workers (isolate-level sandboxing) from this
  demo's container-level sandboxing (Section 6.7 there); this document does
  not repeat that comparison, it only needs to hold.

## Demo Flow

1. Open `https://opencode.cfapps.uk/` and sign in through Cloudflare
   Access. The workspace list (empty on first visit) and a "+ Workspace"
   button are visible.
2. Click **+ Workspace**, choose **GitHub**, paste a small public repository
   URL, and submit. The new workspace card shows `provisioning`, then
   `running` within a few seconds — a real container cold start.
3. Open the workspace. The sidebar shell loads with OpenCode's own web UI
   filling the main area (proxied live from the container) and an **Egress
   Log** panel on the side already showing one `github.com` entry marked
   **credentialed** from the clone.
4. In OpenCode, ask it to summarize the repository. Point out that this
   request is running through Workers AI + AI Gateway — no API key exists
   inside the container.
5. Ask OpenCode to fetch an arbitrary external URL not on the allowlist (for
   example, `curl https://example.com`). Watch the command fail inside
   OpenCode's own terminal-style tool output, and watch a new **denied**
   entry appear in the Egress Log sidebar in real time.
6. Click **Allow** next to that denied host in the sidebar, ask OpenCode to
   retry the same command, and watch it succeed — a new **allowed** entry
   appears for the same host.
7. Open the Cloudflare dashboard's **Containers** page and show the running
   instance for this workspace (image, instance type, uptime). Open
   **Workers Logs** and find the structured `workspace_provisioned`,
   `egress_denied`, `egress_allowed`, and `model_request_routed` events,
   correlated by workspace ID.
8. Open the **AI Gateway** dashboard and show the logged request from step 4
   — the same governed routing and cost visibility demo 6 introduced,
   reached this time from inside a container rather than a browser.
9. Return to the workspace list, **Stop** the workspace (container sleeps,
   D1 status flips to `stopped`), then **Delete** it, and show the D1 row and
   KV secret are both gone.

## Relevant Skills

**Cloudflare / backend skills:**

- `cloudflare`
- `cloudflare-one`
- `cloudflare-terraform-best-practices`
- `cloudflare-deploy-scripts`
- `cloudflare-toolkit`
- `workers-best-practices`
- `wrangler`
- `durable-objects`

**Vue / UI skills:**

- `vue-best-practices`
- `vue-pinia-best-practices`
- `vue-router-best-practices`
- `vue-testing-best-practices`
- `web-perf`

Skills do not replace current documentation. Containers is a beta product
whose API surface changes; retrieve the current Containers reference, the
`@cloudflare/containers` package documentation, the pinned Terraform provider
schema, the Wrangler config schema, and current OpenCode documentation before
relying on any class property, method signature, CLI flag, or limit named in
this document.

## Access Model

Containers are billable, sustained compute, so — following `demos/ai-chat`
and `demos/chat` — the **entire `opencode.cfapps.uk` hostname** is
gated by a single Cloudflare Access self-hosted application backed by an
`allow` policy requiring authentication through a configured identity
provider. There is **no** public bypass application.

- `cloudflareAccess()` is mounted **once, globally** in `src/worker/index.ts`,
  ahead of the routing decision described under "Routing." It does not
  validate the Access `audience`; it derives the caller's email from the
  verified Access identity on every request, never from client input.
- Access answers **"is this a real, authenticated person?"** — it has no
  concept of workspace ownership. **Workspace-level authorization is an
  application-layer concern**, exactly per AGENTS.md's separation-of-concerns
  guidance (the same pattern demo 6 uses for its `is_admin` flag): every
  workspace-scoped request — API call or proxied container request — compares
  the verified Access email against the workspace's `owner_email` column in
  D1 and returns `403` on mismatch, never trusting a client-supplied
  workspace ID alone.
- `src/access-policies.ts` is fail-safe: `/api/*` → `authenticate: true,
  redirect: false`; a catch-all `/` → `authenticate: true, redirect: true`.
  Because the proxy path also lives under `/`, this one catch-all entry
  already covers every proxied request too — there is no separate path
  policy to add for containers.
- `cloudflareAccessPlugin()` is configured in `vite.config.ts` for local
  development, with selectable dev `users`, before `cloudflare()`.

## Architecture Overview

### One Durable Object Per Workspace, Named By Its Own ID

`Workspace extends Container` (from `@cloudflare/containers`). Every other
identifier in this demo — the D1 primary key, the KV secret key, the egress
log's foreign key, and the value the browser cookie names — is the **same
string**: the Durable Object's own ID, minted once with `newUniqueId()` when
a workspace is created and never derived from a name:

```ts
const id = env.WORKSPACE.newUniqueId();
const workspaceId = id.toString(); // canonical identifier, used everywhere
const stub = env.WORKSPACE.get(id);
```

This sidesteps a real ambiguity in the Containers outbound-interception API:
`outbound`/`outboundByHost` handlers are **static** class members that
receive `ctx.containerId`, not a `this`-bound instance, so they cannot reach
instance state directly. The documented pattern for correlating that ID back
to per-instance data is an external lookup keyed by `ctx.containerId` (the
docs' own example: `env.KEYS.get(ctx.containerId)`). By minting the
workspace's identity from `newUniqueId()` up front rather than inventing a
separate UUID and mapping it to a Durable Object name, `ctx.containerId`
*is* the workspace ID everywhere it appears — no second lookup table is ever
needed. **Verify in Phase 1** that `ctx.containerId` is in fact
`this.ctx.id.toString()` for the owning instance (undocumented in prose, only
implied by the example); if it is not, introduce the smallest possible
`containerId → workspaceId` KV mapping and record the correction in
`docs/DECISIONS.md`, exactly as demo 5 recorded its streaming-shape spike
corrections.

### Data Model

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,             -- Durable Object ID (hex); also ctx.containerId
  owner_email TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  repo_url TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'running', 'stopped', 'error', 'deleted')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT
);
CREATE INDEX idx_workspaces_owner ON workspaces (owner_email, created_at DESC);

CREATE TABLE egress_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  host TEXT NOT NULL,
  method TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied', 'credentialed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_egress_log_workspace ON egress_log (workspace_id, created_at DESC);
```

`credentialed` is a distinct decision from `allowed` so the sidebar can badge
"this request left the container with an injected credential" separately
from an ordinary allowed request — a directly visible answer to "does the
agent ever see my token?" (it does not).

Workers KV (`WORKSPACE_SECRETS`) holds exactly one JSON value per workspace,
keyed by `workspaceId`: `{ gitToken?: string; serverPassword: string }`.
Nothing longer-lived than the workspace's own life belongs here; delete the
key when the workspace is deleted.

### Container Image And Bootstrap

A minimal Debian-based Node.js 24 image:

- `git`, `ca-certificates`, `curl`.
- `npm install -g opencode-ai@<pinned version>` — pin a specific version
  deliberately; do not float `latest` in a demo whose CLI flags this document
  depends on.
- A committed `entrypoint.sh` that, on every container start:
  1. If `/etc/cloudflare/certs/cloudflare-containers-ca.crt` exists (it does,
     once `interceptHttps = true` is set — see "Egress Control"), copies it
     into the distro trust store and runs `update-ca-certificates`, per
     current Containers documentation. Also export
     `NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt`
     so Node's own TLS stack (used by both `git` tooling that shells out to
     Node and by `opencode` itself) trusts the same ephemeral CA regardless
     of whether the distro trust store is honored by every consumer. Verify
     both mechanisms empirically in Phase 3; do not assume one implies the
     other.
  2. If `/workspace/repo` does not already exist, runs `git clone
     "$REPO_URL" /workspace/repo` — a **plain, unauthenticated** clone URL.
     The credential, if any, is injected by the Worker's `outboundByHost`
     handler for the matching git host (see "Git Credential Injection"); the
     container process itself never has the token in an environment
     variable, a config file, or `.git/config`.
  3. Writes a small starter `opencode.json` into the repo **only if one does
     not already exist** — conservative default permissions (see current
     OpenCode `permissions`/`policies` documentation) and the model-bridge
     provider configuration from "Model Routing." Never overwrite a
     repository's own committed `opencode.json`.
  4. `cd /workspace/repo && exec opencode web --hostname 0.0.0.0 --port
     "${OPENCODE_PORT:-4096}"`, with `OPENCODE_SERVER_PASSWORD` already set
     from `envVars` (see below) so the server requires the credential the
     Worker injects on every proxied request.

`Workspace`'s class properties:

```ts
export class Workspace extends Container {
  defaultPort = 4096;
  requiredPorts = [4096];
  sleepAfter = "30m";
  interceptHttps = true;
  enableInternet = true; // narrowed to an explicit allowlist — see Egress Control
}
```

`startAndWaitForPorts()` is called once, from a `configure()` RPC method the
Worker invokes at workspace-creation time, passing `REPO_URL`,
`GIT_PROVIDER`, a freshly generated `OPENCODE_SERVER_PASSWORD`, and the AI
Gateway account/gateway identifiers as per-instance `envVars`. The git
token and the generated server password are written to
`WORKSPACE_SECRETS` **before** `startAndWaitForPorts()` runs, so the
outbound handler can find them the moment the container's first request
arrives.

### Git Credential Injection

The container clones over a plain, unauthenticated HTTPS URL. The Worker's
static outbound handlers intercept the request to `github.com` /
`gitlab.com`, look up that workspace's token by `ctx.containerId`, and inject
it before forwarding — the exact pattern Cloudflare's own Containers
documentation demonstrates for this purpose:

```ts
export class Workspace extends Container {
  // ...
  static outboundByHost = {
    "github.com": async (request: Request, env: Env, ctx) => {
      const secret = await env.WORKSPACE_SECRETS.get(ctx.containerId, "json");
      const authed = secret?.gitToken
        ? withHeader(request, "Authorization", `Basic ${toBase64(`x-access-token:${secret.gitToken}`)}`)
        : request;
      await logEgress(env, ctx.containerId, "github.com", request.method, secret?.gitToken ? "credentialed" : "allowed");
      return fetch(authed);
    },
    "gitlab.com": async (request: Request, env: Env, ctx) => {
      const secret = await env.WORKSPACE_SECRETS.get(ctx.containerId, "json");
      const authed = secret?.gitToken
        ? withHeader(request, "Authorization", `Basic ${toBase64(`oauth2:${secret.gitToken}`)}`)
        : request;
      await logEgress(env, ctx.containerId, "gitlab.com", request.method, secret?.gitToken ? "credentialed" : "allowed");
      return fetch(authed);
    },
  };
}
export { ContainerProxy } from "@cloudflare/containers";
```

`export { ContainerProxy }` from the Worker's entry module is required for
outbound interception to work at all — easy to omit, and a documented,
easy-to-hit gotcha. A public repository clones successfully with no token
present (`secret?.gitToken` is `undefined`, the request forwards unmodified,
and the egress log records a plain `allowed`).

### Model Routing

`opencode.json` inside the repository configures a **custom OpenAI-compatible
provider** whose `baseURL` points at a sentinel hostname
(`http://model-bridge.internal/v1`) that is never a real DNS name — it exists
only to be matched by `outboundByHost`:

```ts
static outboundByHost = {
  // ...github.com / gitlab.com above...
  "model-bridge.internal": async (request: Request, env: Env, ctx) => {
    return env.MODEL_BRIDGE.fetch(request); // a WorkerEntrypoint, see below
  },
};
```

`MODEL_BRIDGE` is a `WorkerEntrypoint` in the same Worker script that
translates the incoming OpenAI-style chat-completion request into
`env.AI.run(model, input, { gateway: { id: env.AI_GATEWAY_ID } })` — the same
`AI` binding demo 5 uses, with the `gateway` option demo 6 introduced for
governed routing and cost analytics, called from **inside the container's
own outbound path** instead of from a browser-facing route. This is the
preferred design specifically because it needs **no external HTTPS call and
no Cloudflare API token at all**: the request never leaves the Workers
runtime, so there is no credential for the container to hold or leak.

**Spike required before Phase 3 locks this in**: confirm that (a) OpenCode's
custom-provider mechanism accepts a fully local sentinel `baseURL` without
requiring DNS to resolve it (interception happens before DNS, so this should
be transparent, but verify), and (b) the request/response shape OpenCode's
`@ai-sdk/openai-compatible` client sends is one `MODEL_BRIDGE` can translate
without reimplementing an unbounded slice of the OpenAI API. If either
assumption fails, fall back to OpenCode's **built-in "Cloudflare AI Gateway"
provider** (documented, zero custom code) with a narrowly-scoped Wrangler
secret (`AI_GATEWAY_TOKEN`, permission: AI Gateway Run only) injected the
same way the git token is — via an `outboundByHost` handler for
`gateway.ai.cloudflare.com` that attaches the real token before forwarding
upstream, so the fallback still keeps the token out of the container's own
environment. Record whichever path is taken, and why, in
`docs/DECISIONS.md`.

### Egress Control

`enableInternet = true` plus a **default-deny catch-all** implemented in the
static `outbound` handler, not `deniedHosts`/`allowedHosts` alone — the
allowlist is per-workspace and changes at runtime, so it needs to be read
from D1 rather than fixed at the class level:

```ts
static outbound = async (request: Request, env: Env, ctx) => {
  const host = new URL(request.url).hostname;
  const allowed = await isHostAllowed(env, ctx.containerId, host);
  await logEgress(env, ctx.containerId, host, request.method, allowed ? "allowed" : "denied");
  if (!allowed) return new Response("Blocked by workspace egress policy", { status: 403 });
  return fetch(request);
};
```

`outboundByHost` entries (git hosts, the model bridge) run **before** this
catch-all per the documented precedence order and are unaffected by the
allowlist. Seed every new workspace's allowlist with package-registry and
OS-mirror hosts a coding agent legitimately needs (`registry.npmjs.org`,
`pypi.org`, `files.pythonhosted.org`, `deb.debian.org`, `deb.debian.org`-style
mirrors as appropriate to the image) — verify and finalize this list in
Phase 4 against what the chosen base image's package manager actually
contacts, rather than guessing. The sidebar's **Allow** action calls `POST
/api/workspaces/:id/allowlist`, which appends a host to a per-workspace table
(or a JSON column on `workspaces` — pick one in Phase 4 and document the
choice) that `isHostAllowed()` reads.

Every decision — allowed, denied, or credentialed — is written to
`egress_log`. The sidebar polls `GET /api/workspaces/:id/egress?since=...`
every few seconds while a workspace is open; a Durable-Object-pushed
WebSocket feed is deliberately not used here (see "Do not use a Durable
Object unless the application needs coordination, strong consistency, or
persistent connections" in AGENTS.md) — polling a D1 table the outbound
handlers already write to is simpler, reuses D1 rather than adding a second
live-update mechanism, and a few seconds of latency does not undermine the
demo.

### Routing

Every request reaches the Worker first (`run_worker_first: true` — verify
this boolean form against the current Wrangler config schema in Phase 1; it
replaces an explicit path-prefix array precisely because the routing
decision below is dynamic, not path-based). The Worker's top-level dispatch,
in order:

1. `/api/*` → the Hono API (workspace CRUD, egress log, `/api/me`).
2. `/_app/*` → `env.ASSETS.fetch()`, which serves this demo's own Vue SPA
   (built with Vite `base: "/_app/"`), including its own
   single-page-application fallback for client-side routes like
   `/_app/workspaces/:id`.
3. Everything else (including bare `/`): if an httpOnly `active_workspace`
   cookie names a workspace the caller owns and it is `running`, proxy the
   request 1:1 to that workspace's container (`workspace.fetch(request)`,
   after injecting the stored `OPENCODE_SERVER_PASSWORD` as a `Basic` auth
   header the container's `opencode web` process already expects). Otherwise,
   `302` to `/_app/`.

The SPA's workspace-shell view (`/_app/workspaces/:id`) is the **only** place
that sets the `active_workspace` cookie: on mount, it calls `POST
/api/workspaces/:id/activate` (which re-checks ownership and workspace
status before setting the cookie), then renders a full-height
`<iframe src="/">` next to the Egress Log sidebar. Because the iframe is
same-origin, the browser reuses the same Access session and cookies, and
WebSocket connections OpenCode's own UI opens from inside the iframe work
exactly as they would if the container were the whole page. A **Leave
Workspace** control, always visible in the sidebar chrome, calls `POST
/api/workspaces/deactivate` (clears the cookie) and navigates back to
`/_app/`.

This reserved-prefix design is what makes per-workspace subdomains
unnecessary: because the proxy always operates at the true origin root
(never a rewritten path prefix), OpenCode's own bundle's root-relative asset
URLs (`/assets/*.js`, its own `/api/*` calls) resolve correctly with **zero**
rewriting, at the cost of the one restriction named under "Out Of Scope."

### Workspace Lifecycle

`provisioning → running → stopped → running (…) → deleted`, plus `error` on a
failed clone or container start. State transitions:

- **Create** (`POST /api/workspaces`): insert the D1 row (`status =
  provisioning`), write the KV secret, call `configure()` on the new
  Durable Object stub, which starts the container and clones the repo.
  `configure()` flips the D1 row to `running` on success or `error` (with
  `error_message`) on failure — the client polls `GET /api/workspaces/:id`
  until it leaves `provisioning`.
- **Stop** (`POST /api/workspaces/:id/stop`): calls the Durable Object's
  `stop()` (inherited from `Container`, sends `SIGTERM`), flips D1 to
  `stopped`. The container's own `sleepAfter` also stops it automatically
  after 30 minutes of inactivity without a manual stop, flipping status via
  the class's `onStop()` hook.
- **Reopen**: opening a `stopped` workspace calls `startAndWaitForPorts()`
  again. **The container's disk is ephemeral and resets on every stop** (see
  the Containers reference), so `/workspace/repo` will *not* already exist —
  `entrypoint.sh` re-clones unconditionally on this path. Document this
  plainly: a stopped-then-restarted workspace **re-clones the repository
  from scratch** and loses any uncommitted work. This is a real,
  demo-relevant limitation worth calling out explicitly in `DEMO.md` and
  `README.md`, not a bug to work around — Durable Object storage, not
  container disk, is the only thing that survives a stop.
- **Delete** (`DELETE /api/workspaces/:id`): `destroy()` the container, clear
  the Durable Object's own storage, delete the KV secret, delete the D1 row
  (cascade `egress_log` rows or leave them for audit history — decide and
  document in Phase 3).

## API And Routing

All routes below live under `/api/*` except the catch-all proxy described
under "Routing":

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/me` | Verified identity, for the header. |
| `GET` | `/api/workspaces` | List workspaces owned by the caller. |
| `POST` | `/api/workspaces` | Create a workspace (`provider`, `repoUrl`, `token?`). |
| `GET` | `/api/workspaces/:id` | Workspace status (for provisioning polling). |
| `POST` | `/api/workspaces/:id/activate` | Ownership + status check; sets the `active_workspace` cookie. |
| `POST` | `/api/workspaces/deactivate` | Clears the `active_workspace` cookie. |
| `POST` | `/api/workspaces/:id/stop` | Stops the container; keeps the workspace. |
| `DELETE` | `/api/workspaces/:id` | Stops, destroys, and removes the workspace entirely. |
| `GET` | `/api/workspaces/:id/egress` | Recent egress log rows (`since` query param). |
| `POST` | `/api/workspaces/:id/allowlist` | Adds a host to the workspace's egress allowlist. |

Every handler re-derives `owner_email` from the verified Access identity and
compares it against the D1 row before doing anything else; a workspace ID
that exists but belongs to someone else returns `404`, not `403`, so
ownership is never confirmed to an unauthorized caller.

## Containers Has No Local Simulation In CI

Parallel to demo 5's "Workers AI Has No Local Simulation," this is the
single most important operational fact shaping this demo's testing story.
Verify every point below during Phase 1 and record findings in
`docs/DECISIONS.md`:

- `vite dev` / `wrangler dev` **can** run a real container locally, but only
  with a Docker-compatible engine (Docker Desktop or Colima) installed and
  running. This is a genuinely new local prerequisite for this repository —
  state it prominently in `README.md`.
- `@cloudflare/vitest-pool-workers` has no documented container runtime.
  Treat starting a real container as **untestable in CI**, exactly like real
  Workers AI inference in demo 5. Do not attempt to make
  `tests/integration/vitest.config.ts` start a `Workspace` container; if the
  pool's config loader fails outright when `containers` is present in
  `wrangler.jsonc` without Docker available, the integration project may
  need its own dedicated Wrangler config that omits the `containers` block
  entirely, exercising only the Worker's HTTP routing, D1/KV logic, and
  Access enforcement with the `Workspace` Durable Object's container-facing
  methods (`configure()`, `fetch()`) stubbed or not exercised. Confirm this
  constraint exists (or does not) before designing the integration suite,
  and document whichever is true.
- Extract every unit-testable rule into a **pure function** that does not
  require a running container: `isHostAllowed()`, the credential-header
  builder, the egress-log row shaper, the cookie-based routing decision
  (given a request, a cookie value, and workspace ownership data, decide
  proxy vs. redirect vs. asset), and the `ctx.containerId`-keyed KV lookup
  wrapper. These make up the bulk of this demo's actual logic and are fully
  testable without Docker.
- The one thing that cannot be automated is a real clone, a real `opencode
  web` boot, and real egress interception. Provide a documented **manual
  smoke check** in `README.md` and `DEMO.md`: create a workspace against a
  small public repository on the deployed hostname and confirm clone,
  `opencode web` reachability through the proxy, a denied egress attempt,
  an allowed retry after adding the host, and workspace deletion.

## Implementation Plan

### Phase 1 — Scaffold, infrastructure baseline, and spikes

1. Create an independent `demos/opencode` demo using Vue 3, Vuetify, Pinia,
   Vue Router, Vite, Hono, and TypeScript, following the canonical
   `demos/url-shortener` / `demos/chat` layout, adapted for the reserved
   `/_app/` asset prefix described under "Routing" (`vite.config.ts`'s
   `base: "/_app/"`, and an `index.html` served only from that prefix).
2. Provision the baseline resources with Terraform: a Worker (explicit
   `subdomain` block), the `opencode.cfapps.uk` custom domain (with
   the one-time inert bootstrap version/deployment), a D1 database, a KV
   namespace, Workers Logs, and automatic tracing with explicit sampling.
   Read configuration from `../.env` via the `dotenv` provider; set
   `DEMO_NAME=opencode` and `DEMO_DOMAIN=cfapps.uk`. **No Terraform
   resource for `containers`** — comment this explicitly beside the Worker
   resource, per "Explicit Exceptions."
3. Spike and record in `docs/DECISIONS.md`, **before writing any Container
   code**:
   - Whether `ctx.containerId` inside a static `outbound`/`outboundByHost`
     handler equals `this.ctx.id.toString()` for the handled instance (see
     "One Durable Object Per Workspace").
   - The current Workers Paid plan requirement for Containers, and the
     current Docker/Colima local-dev prerequisite, for `README.md`.
   - Whether `@cloudflare/vitest-pool-workers` can load a Wrangler config
     containing a `containers` block at all without a running Docker daemon
     (see "Containers Has No Local Simulation In CI").
   - `opencode web`'s exact CLI flags and `OPENCODE_SERVER_PASSWORD`
     behavior, run once locally against a scratch directory.
4. Commit `wrangler.jsonc.tpl` with `{{placeholder}}` markers for every
   Terraform-sourced value, the `containers` array (`class_name:
   "Workspace"`, `image: "./container/Dockerfile"`, `instance_type:
   "standard-1"`, a demo-appropriate `max_instances`), the paired
   `durable_objects` binding and `new_sqlite_classes` migration, `assets`
   configured for the `/_app/` prefix, `run_worker_first: true`, and a
   current `compatibility_date`. Add `infra/local-outputs.json` and wire
   `generate-wrangler -c -l infra/local-outputs.json` into the standard set
   of `pre*` hooks per AGENTS.md. Commit a `.dev.vars` (no secrets) for a
   local `ENVIRONMENT`.
5. Mirror `demos/chat`'s `package.json` scripts (`build`, `check:*`,
   `format:*`, `generate:*`, `start`, `test*`, `deploy`, `teardown`), adding
   D1 migration scripts (`db:migrate:remote`/`db:migrate:local`, both `CI=1`)
   for the schema in "Data Model."

### Phase 2 — Access and owner-scoped authorization

6. Gate the entire hostname with one Cloudflare Access self-hosted
   application backed by an `allow` policy requiring authentication — no
   bypass — following `demos/ai-chat`.
7. Mount `cloudflareAccess()` globally in `src/worker/index.ts`. Implement
   `GET /api/me` from the verified identity.
8. Add `src/access-policies.ts` (fail-safe `/api/*` and catch-all `/` per
   "Access Model") and `cloudflareAccessPlugin()` in `vite.config.ts` for
   local development.
9. Implement a small `requireWorkspaceOwner()` Hono middleware:
   loads the workspace by ID from D1, compares `owner_email` to the verified
   Access identity, and returns `404` on any mismatch (never confirming
   existence to a non-owner). Unit-test it directly against fixture rows.

### Phase 3 — Container image, Workspace Durable Object, and lifecycle

10. Author `container/Dockerfile` and `container/entrypoint.sh` per
    "Container Image And Bootstrap": Node.js 24 base, `git`,
    `ca-certificates`, pinned `opencode-ai`, CA-trust refresh, conditional
    clone, starter `opencode.json` templating, and `exec opencode web`.
11. Implement `src/worker/workspace/Workspace.ts` extending `Container`:
    class properties (`defaultPort`, `sleepAfter`, `interceptHttps`,
    `enableInternet`), the `configure()` RPC method (writes the KV secret,
    calls `startAndWaitForPorts()` with per-instance `envVars`, flips D1
    status), `fetch()` overridden to inject the stored
    `OPENCODE_SERVER_PASSWORD` as a `Basic` auth header before delegating to
    `super.fetch()` (required for WebSocket support — never
    `containerFetch()` for this path), and the stop/destroy RPC methods used
    by the lifecycle routes.
12. Implement `src/worker/routes/workspaces.ts`: the full CRUD/status/
    activate/deactivate/stop route table from "API And Routing," each
    guarded by `requireWorkspaceOwner()` where applicable, mounted from
    `src/worker/index.ts` (routing only).
13. Emit structured logs via `cloudflareLogger()` for
    `workspace_created`, `workspace_provisioned`, `workspace_stopped`,
    `workspace_deleted`, and `workspace_provisioning_failed` — after the
    Access and ownership guards, carrying workspace ID, provider, and
    status, never a git token or the container's server password.

### Phase 4 — Egress control, credential injection, and model routing

14. Implement `src/worker/egress/` as pure, unit-tested functions:
    `isHostAllowed()`, `buildCredentialHeader()` (GitHub/GitLab Basic-auth
    encoding), `shapeEgressLogRow()`, and the KV secret read/write wrapper —
    kept independent of the static class members so they are testable
    without a container.
15. Wire `Workspace.outboundByHost` (`github.com`, `gitlab.com`, the model
    bridge sentinel host) and `Workspace.outbound` (the default-deny
    catch-all) per "Git Credential Injection" and "Egress Control," calling
    the pure functions from step 14. Export `ContainerProxy` from
    `src/worker/index.ts`.
16. Implement the `MODEL_BRIDGE` `WorkerEntrypoint` per "Model Routing,"
    including the spike-driven fallback if the local-binding bridge does not
    pan out. Log `model_request_routed` with model, latency, and token
    counts if available — never prompt or completion content, following
    demo 5's logging discipline exactly.
17. Implement `GET /api/workspaces/:id/egress` and `POST
    /api/workspaces/:id/allowlist`, both owner-guarded.

### Phase 5 — Browser application

18. Build the workspace list view (`/_app/`): cards showing status, provider,
    repository, and Stop/Delete/Open actions; a **+ Workspace** dialog
    (provider select, repository URL, optional token field marked
    sensitive) meeting WCAG 2.2 AA on desktop and mobile.
19. Build the workspace shell view (`/_app/workspaces/:id`): activates the
    workspace on mount, renders the `<iframe src="/">` next to the Egress
    Log sidebar (polling `GET .../egress`, an **Allow** control per denied
    host, and status badges distinguishing `allowed` / `denied` /
    `credentialed`), and the always-visible **Leave Workspace** control.
    Handle the "workspace not yet running" and "workspace errored" states
    with a clear message instead of an empty iframe.
20. Manage state in Pinia: a `session` store (identity), a `workspaces`
    store (list + status polling), and an `egress` store (per-workspace log
    entries + allowlist mutations). Keep `src/client/main.ts`
    bootstrap-only.

### Phase 6 — Tests, deployment, and documentation

21. Add the three Vitest projects. `worker`: `isHostAllowed()`,
    `buildCredentialHeader()`, `shapeEgressLogRow()`, the routing-decision
    function (cookie + ownership → proxy/redirect/assets), and
    `requireWorkspaceOwner()`. `client`: workspace list, creation dialog
    validation, the shell view's activation/error states, and the egress
    sidebar's allow action. `integration`: the Worker's HTTP routing,
    Access enforcement, D1/KV-backed workspace CRUD, and ownership
    boundaries — **without** a real container, per "Containers Has No Local
    Simulation In CI." Configure `@vitest/coverage-istanbul`.
22. Provide `npm run deploy` (Terraform init/apply, `generate-wrangler`,
    D1 migrations, `vite build`, `wrangler deploy` — which builds and
    pushes the container image) and `npm run teardown` (stop/destroy any
    remaining workspaces via a documented cleanup step — containers left
    running are billable — then `terraform destroy`).
23. Write `README.md` (prerequisites including Docker/Colima and the Workers
    Paid plan requirement, environment configuration including the git-
    token handling model, local development, testing and its container
    limitation, exact deployment steps, the manual smoke check, and exact
    teardown) and `DEMO.md` (presenter script matching "Demo Flow," with
    exact dashboard locations for Containers, Workers Logs, and AI Gateway).
    Add JSDoc to every authored TypeScript declaration.
24. Extend `.env.example` from the baseline with the additional account
    permissions this demo needs (Containers, Durable Objects, D1, KV) and
    `DEMO_NAME=opencode`. Write `EXPLAIN-DEMO.md`: what Containers
    teaches, the credential-injection and egress-control design and why it
    mirrors Cloudflare's own "Enterprise AI Vibe Coding Platform" reference
    architecture at curriculum scale, the reserved-path routing decision and
    the per-workspace-subdomain alternative it deliberately avoids, and
    further reading linking the Containers docs, the outbound-traffic guide,
    and that reference architecture.
25. Verify formatting, linting, type checking, all three Vitest projects, the
    production build, the generated Wrangler configuration (including a
    successful local container build if Docker is available in CI; skip with
    a clear message if not), and `terraform fmt -check` / `terraform
    validate`. Record every Phase 1 and Phase 4 spike finding in
    `docs/DECISIONS.md`. Do not run `terraform apply`, deploy, or destroy
    real resources unless the operator explicitly requests it and provides
    the environment.
