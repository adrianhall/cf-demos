# Demo 4: Enterprise Chat

Directory: `demos/chat`

Domain: `chat.cfapps.uk`

Cloudflare products: Workers, Static Assets, Cloudflare Access, D1, and Durable
Objects (with WebSockets).

## Behavior

- Provide a channel-based chat workspace, styled with the Cloudflare palette,
  where a signed-in user picks a channel from a shared channel list and joins a
  live conversation. The demo borrows the channel-and-message *concept* familiar
  from tools like Slack; it is not a Slack clone.
- Let **any signed-in user add or remove channels**. Channel management is
  deliberately unrestricted — there is no admin role — so the demo stays simple
  and every participant can drive it. Adding a channel makes it available to
  everyone; removing a channel deletes it for everyone and tears down its
  Durable Object state.
- Model **one Durable Object per channel**. The Worker routes every request for
  a channel to that channel's single Durable Object with `getByName(channel)`,
  the same way a chat product routes a room by name.
- Hold each channel's authoritative state — its recent message history and its
  set of connected participants — inside the channel's Durable Object, using the
  Durable Object's embedded SQLite storage for messages so state survives
  hibernation and eviction.
- Accept a WebSocket connection per participant, using the **hibernatable**
  WebSocket API so an idle channel consumes no duration while its state and open
  sockets are preserved.
- **Broadcast** every accepted message to all sockets currently connected to the
  same channel's Durable Object, and only that channel's sockets, so channels
  are isolated from one another by construction (different names → different
  Durable Objects).
- On connect (and reconnect), **replay recent history** from the Durable
  Object's SQLite store to the newly connected socket so a client that dropped
  and reconnected recovers the authoritative view of the channel rather than a
  blank window.
- Store the shared **channel directory** (which channels exist) in D1, reused
  from Demo 2, so the channel list is a small relational catalog that any user
  can add to or remove from and that the Worker validates against before routing
  to a Durable Object.
- Write informational structured logs for channel creation, channel removal,
  channel joins, posted messages, and disconnects.

This is the curriculum's introduction to **Durable Objects** and **WebSockets**.
The one new lesson is stateful coordination over a persistent connection:
routing to one coordination atom per channel, broadcasting to every participant
of that atom, and recovering authoritative room state from the Durable Object's
own storage after a client reconnects. Workers, Static Assets, and Cloudflare
Access are reused from earlier demos, and D1 (from Demo 2) is reused only to hold
the channel directory. KV is deliberately **not** used: the Durable Object owns
the live room state that KV would otherwise be misapplied to, and D1 already
covers the small shared catalog, so adding KV would introduce a second state
store without teaching anything new.

## Demo Flow

1. Open two browser windows (or one normal and one private) and sign in as **two
   different users** — User A and User B.
2. In both windows, select the same channel (start with the seeded `general`)
   from the channel list.
3. Post a message as User A. It appears **immediately in both windows**, labeled
   with User A's identity, because the channel's Durable Object broadcast it to
   every connected socket.
4. Post a reply as User B and watch it appear in both windows.
5. As User A, **add a new channel** (for example `deploys`). It appears in User
   B's channel list too, since the directory is shared in D1. Switch one window
   to it and confirm that messages posted in `general` do **not** appear there —
   a different channel name routes to a different Durable Object.
6. Close User B's window entirely, then reopen it and rejoin `general`. Confirm
   that the **recent history replays** — User B recovers the authoritative
   conversation from the channel's Durable Object storage, not an empty room —
   demonstrating state recovery after reconnect.
7. As either user, **remove the `deploys` channel**. Confirm it disappears from
   both channel lists, any window still viewing it is dropped with a clear
   notice, and its Durable Object state is gone (rejoining a channel by that name
   later starts empty).
8. Open Workers Logs and locate the `channel_created`, `channel_removed`,
   `channel_joined`, `message_posted`, and `channel_left` events, correlated by
   channel and request.

## Relevant Skills

**Cloudflare / backend skills:**

- `cloudflare`
- `cloudflare-one`
- `durable-objects`
- `cloudflare-terraform-best-practices`
- `cloudflare-deploy-scripts`
- `cloudflare-toolkit`
- `workers-best-practices`
- `wrangler`

**Vue / UI skills:**

- `vue-best-practices`
- `vue-pinia-best-practices`
- `vue-router-best-practices`
- `vue-testing-best-practices`
- `web-perf`

Skills do not replace current documentation. Retrieve current Cloudflare docs,
the pinned Terraform provider schema, Workers types, the Durable Objects and
hibernatable WebSocket API references, and the Wrangler schema before relying on
fields, limits, APIs, migration syntax, or command options.

## Access Model

Every participant must have a verified identity — the whole point is showing who
said what and keeping two distinct users apart — so this demo gates the **entire
`chat.cfapps.uk` hostname** with a single Cloudflare Access self-hosted
application backed by an `allow` policy that requires authentication through "any"
configured identity provider, exactly like `demos/todo-app`. There is **no**
public bypass application: no route is anonymous.

- The SPA shell is served by the `ASSETS` `single-page-application` fallback and
  is gated at the edge by Access before the request reaches the Worker or static
  assets, so page routes need no Worker route or `run_worker_first` entry.
- `cloudflareAccess()` is mounted **once, globally**, in `src/worker/index.ts`.
  Following `demos/todo-app`, this multi-user demo deliberately does **not**
  validate the Access `audience`; it derives each caller's stable identity
  (email) from the verified Access identity on every request — never from
  client-supplied input.
- The shared path-policy array in `src/access-policies.ts` marks the whole app
  `authenticate: true`: `/api/*` → `authenticate: true, redirect: false` (so API
  and WebSocket-upgrade requests get a `401`/`403` rather than an HTML redirect),
  and a final catch-all `/` → `authenticate: true, redirect: true` for pages.
  Unlike `demos/media-drop`, this array is **fail-safe**: a newly added route
  with no earlier match falls through to the authenticated catch-all, so a
  forgotten route is closed, not open.

WebSocket authentication is the one Access subtlety this demo introduces. The
browser opens the WebSocket to a same-origin `/api/...` URL, so the upgrade
request carries the Access session cookie and is validated by the edge Access
application and by `cloudflareAccess()` just like any other request. The Worker
verifies the identity on the upgrade request, then forwards the request to the
channel's Durable Object, attaching the **verified** email on a trusted internal
header (for example `X-Chat-Identity`). The Worker MUST strip any inbound
`X-Chat-Identity` from the client before setting it, so the Durable Object can
trust that header as coming only from the Worker. The Durable Object never sees
or validates a JWT itself; it trusts the Worker-supplied identity and pins it to
the socket, so a client can never spoof another participant's identity in the
messages it sends.

## API and routing

All routes are authenticated and live under `/api/*`:

- `GET /api/me` — the verified identity, for the UI header and message labeling.
- `GET /api/channels` — list channels from the D1 directory.
- `POST /api/channels` — **add** a channel (validated, lowercased, normalized
  `name`), inserted into the D1 directory by any authenticated user. This makes
  the routing lesson tangible: a new name becomes a new Durable Object the first
  time someone joins it.
- `DELETE /api/channels/:channel` — **remove** a channel. Any authenticated user
  may delete any channel (no admin role). The Worker tells the channel's Durable
  Object to purge its state and disconnect any live sockets, then deletes the D1
  directory row, so a successful removal leaves no directory entry and no Durable
  Object state.
- `GET /api/channels/:channel/ws` — the **WebSocket upgrade** endpoint. The
  Worker confirms the channel exists in D1, then forwards the upgrade to
  `env.CHAT_ROOM.getByName(channel)` with the verified identity header. The
  Durable Object accepts the socket, replays recent history, and adds the socket
  to the channel's connection set.

Message exchange after the upgrade happens entirely over the WebSocket, handled
by the Durable Object — there is no per-message REST endpoint. Recent history is
delivered by the Durable Object as the first frames on connect, which is what
makes reconnect recovery a Durable Object lesson rather than a client cache.

Channel management is intentionally unrestricted: because any authenticated user
is a legitimate manager, the create and delete routes need only the global
Access identity check, not a per-email admin allowlist. The lesson is Durable
Object lifecycle (a name becoming a live coordination atom and later being torn
down), not authorization.

## Durable Object design

`ChatRoom extends DurableObject<Env>` is the coordination atom, one instance per
channel name:

- **Schema init in the constructor** via `blockConcurrencyWhile()` only: create a
  `messages` table (`id` autoincrement, `author`, `body`, `created_at`) in the
  Durable Object's SQLite storage. Do not hold `blockConcurrencyWhile()` across
  request or socket I/O.
- **Upgrade handling** in `fetch()`: create a `WebSocketPair`, call
  `ctx.acceptWebSocket(server)` (the hibernatable API, not `server.accept()`),
  attach the Worker-supplied identity to the socket with
  `server.serializeAttachment({ email })` so it survives hibernation, replay the
  last N messages from SQLite to the new socket, broadcast a lightweight presence
  update, and return the client socket with `101`.
- **Message handling** in `webSocketMessage(ws, message)`: read the author from
  `ws.deserializeAttachment()` (never from the message payload), validate the
  body (non-empty after trim, max length, reject control characters), **persist
  it to SQLite first**, then broadcast the stored message to every socket from
  `ctx.getWebSockets()`. Persist-first, cache-second guarantees a message is in
  authoritative state before any client is told about it.
- **Disconnect handling** in `webSocketClose()` / `webSocketError()`: drop the
  socket and broadcast an updated presence count.
- **Removal** via an RPC method (for example `destroy()`): broadcast a
  channel-removed notice to every connected socket, close each socket with a
  clear close code, and call `ctx.storage.deleteAll()` to erase the message table
  and any other stored state. The Worker calls this before deleting the D1 row so
  no orphaned Durable Object state remains; because Durable Objects are addressed
  by name, a channel later recreated with the same name starts from an empty,
  freshly initialized store.
- **Recovery**: because messages live in SQLite, a fully idle channel can
  hibernate and even be evicted, yet a later reconnect replays the same
  authoritative history. In-memory-only state would be lost; this demo keeps the
  message log durable and treats any in-memory participant list as a cache
  rebuilt from `ctx.getWebSockets()`.

Keep the message history bounded (retain and replay only the most recent N
messages per channel) so the demo stays focused and the Durable Object storage
does not grow without limit; long-term archival is out of scope.

## Implementation Plan

### Phase 1 — Scaffold and shared infrastructure

1. Create an independent `demos/chat` demo using Vue 3, Vuetify, Pinia, Vue
   Router, Vite, Hono, and TypeScript, following the canonical
   `demos/url-shortener` layout (`infra/`, `src/worker/`, `src/client/`,
   `tests/integration/`, `.env.example`, `README.md`, `DEMO.md`, `biome.json`,
   `tsconfig.json`, `vite.config.ts`, root `vitest.config.ts`).
2. Provision the baseline resources with Terraform: a Worker, the
   `chat.cfapps.uk` custom domain (with the one-time inert bootstrap
   version/deployment so `cloudflare_workers_custom_domain` can attach without
   error `100124`), Workers Logs, and automatic tracing with explicit sampling.
   Read all configuration from `../.env` via the `dotenv` provider; set
   `DEMO_NAME=chat` and `DEMO_DOMAIN=cfapps.uk`.
3. Provision a D1 database (for the channel directory) with Terraform and export
   its binding details as Terraform outputs (`d1_database_id`,
   `d1_database_name`, plus `worker_name`, `hostname`, `environment`, and
   `cloudflare_team_domain`). Terraform owns the database resource; Wrangler owns
   the D1 schema migrations, the Durable Object migration, and all Worker
   deployments. The Durable Object namespace is created and torn down with the
   Worker itself — it needs no separate Terraform resource.
4. Commit a single `wrangler.jsonc.tpl` with `{{placeholder}}` markers for every
   Terraform-sourced value (Worker name, D1 database id/name,
   `CLOUDFLARE_TEAM_DOMAIN`, `ENVIRONMENT`). Bind D1 as `DB` (with
   `migrations_dir`), declare the Durable Object binding
   (`durable_objects.bindings` → `{ "name": "CHAT_ROOM", "class_name":
   "ChatRoom" }`) and the SQLite migration (`migrations` → `{ "tag": "v1",
   "new_sqlite_classes": ["ChatRoom"] }`), and configure `assets` with
   `not_found_handling: single-page-application` and `run_worker_first:
   ["/api/*"]`. Set a current `compatibility_date` (≥ `2024-04-03` for Durable
   Object RPC) and enable `nodejs_compat`. Add a committed
   `infra/local-outputs.json` with hardcoded local values (including a local
   D1 database id/name); running `generate-wrangler -c -l
   infra/local-outputs.json` fails fast if any `{{marker}}` has no matching
   key. Wire it into `prebuild`, `prestart`, and `precheck:types` as `run-s
   generate:wrangler:local generate:types`. Generate binding types from
   `wrangler.jsonc`; never hand-maintain the binding
   interface. Commit a `.dev.vars` (no secrets) that sets a local `ENVIRONMENT`.

### Phase 2 — Cloudflare Access (authenticated identity)

5. Gate the entire `chat.cfapps.uk` hostname with a single Cloudflare Access
   self-hosted application backed by an `allow` policy that requires
   authentication through a configured identity provider — **no** public bypass
   policy, following `demos/todo-app`. The SPA shell is served by the `ASSETS`
   `single-page-application` fallback and gated at the edge by Access before the
   request reaches the Worker.
6. Mount `cloudflareAccess()` **once, globally** in `src/worker/index.ts`.
   Following `demos/todo-app`, do **not** validate the audience; derive the
   caller's stable identity (email) from the verified Access identity on every
   request — never from client-supplied input. On the WebSocket upgrade route,
   after the identity is verified, strip any inbound `X-Chat-Identity` header and
   set it to the verified email before forwarding the request to the Durable
   Object, so the Durable Object can trust that header exclusively as coming from
   the Worker.
7. Add `src/access-policies.ts` exporting the shared path-policy array used by
   both the Worker middleware and the local Vite plugin: `/api/*` →
   `authenticate: true, redirect: false` (so API and WebSocket-upgrade requests
   receive a status code, not an HTML redirect); a final catch-all `/` →
   `authenticate: true, redirect: true` for pages. Every entry is
   `authenticate: true`, so the array is fail-safe: any future route falls
   through to the authenticated catch-all.
8. Configure the toolkit's development-only `cloudflareAccessPlugin()` in
   `vite.config.ts` before `cloudflare()`, passing the same path-policy array so
   local dev — including the WebSocket upgrade path — matches production. Provide
   selectable dev `users` matching `.env.example` defaults (at least two distinct
   identities so the two-user demo works locally with one click each), and enable
   development tokens only behind `import.meta.env.DEV`. Render an unconditional
   logout control that navigates to `/cdn-cgi/access/logout`, so signing in as
   the wrong identity during local development is recoverable.

### Phase 3 — Durable Object, channel directory, and API (the core lesson)

9. Define the D1 schema as a Wrangler migration: a `channels` table keyed by an
   immutable, validated channel `name` (lowercase, normalized, unique) with
   `created_by` (the verified identity email) and `created_at`. **Seed** at least
   `general` and `random` in the migration so the demo has channels on first
   load. Run migrations through Wrangler with the atomic `db:migrate:remote` /
   `db:migrate:local` scripts (each setting `CI=1`, targeting the `DB` binding,
   and stating `--remote`/`--local` explicitly).
10. Implement the channel directory domain as separate files under
    `src/worker/channels/`: a D1 repository (list, create, remove, exists), input
    validation (name format, length, reserved names), and shared types. The
    directory is a small relational catalog only; it holds **no** messages.
    Removal deletes only the directory row — purging the channel's Durable Object
    state is the Durable Object's own responsibility (step 11), invoked by the
    delete route (step 12).
11. Implement the `ChatRoom` Durable Object in `src/worker/chat-room/` as its own
    module (class plus colocated helpers and types), following the design in
    "Durable Object design" above: SQLite `messages` table created in the
    constructor via `blockConcurrencyWhile()`; `fetch()` performing the
    hibernatable WebSocket upgrade (`ctx.acceptWebSocket`), attaching the
    Worker-supplied identity via `serializeAttachment`, replaying the bounded
    recent history, and broadcasting a presence update; `webSocketMessage()`
    reading the author from `deserializeAttachment()`, validating the body,
    persisting to SQLite **before** broadcasting to `ctx.getWebSockets()`; a
    `destroy()` RPC method that notifies and closes every socket and calls
    `ctx.storage.deleteAll()`; and `webSocketClose()`/`webSocketError()`
    broadcasting updated presence. Export `ChatRoom` from the Worker entry so the
    binding resolves.
12. Implement the API routers under `src/worker/routes/`, mounted from
    `src/worker/index.ts` (routing only): a `channels` router (`GET`/`POST
    /api/channels`, `DELETE /api/channels/:channel`, `GET /api/me`) and a `rooms`
    router that owns `GET /api/channels/:channel/ws`. The upgrade handler
    validates the channel exists in D1, rejects non-upgrade requests, obtains the
    stub with `env.CHAT_ROOM.getByName(channel)`, and forwards the request with
    the trusted identity header. The delete handler validates the name, calls
    `env.CHAT_ROOM.getByName(channel).destroy()` to purge state and disconnect
    live sockets, then removes the D1 row (Durable-Object-state first, directory
    row second, so a successful delete leaves neither). Return RFC 9457 problem
    details for all error paths (unknown channel, invalid name, non-WebSocket
    request), and a `404` for a channel that does not exist so routing is
    explicit.
13. Enforce input safety everywhere untrusted data enters: validate and normalize
    channel names before any D1 write, delete, or Durable Object routing, and cap
    message size and reject control/oversized payloads inside the Durable Object
    before persisting. Never route to a Durable Object for an unvalidated name.
14. Emit informational structured logs via `cloudflareLogger()` —
    `channel_created`, `channel_removed`, `channel_joined`, `message_posted`,
    `channel_left` — each placed **after** the Access and validation guards so
    they reflect only successful, authorized activity. Log the channel name, a
    message id, and the participant count; never log message bodies beyond what
    the demo needs, and never log tokens, authorization headers, or the Access
    JWT.

### Phase 4 — Browser application

15. Build a focused, responsive channel-chat Vue 3 + Vuetify interface, styled
    with the Cloudflare palette and using Feather Icons, that meets WCAG 2.2 AA
    on desktop and mobile:
    - A channel sidebar listing channels from `GET /api/channels`, with an add-
      channel control and a per-channel remove control (both available to any
      user), and the selected channel highlighted. A removed channel disappears
      from the list; if the user was viewing it, show a clear notice and return
      them to a remaining channel.
    - A message pane showing the replayed history and live messages, each labeled
      with its author and timestamp, plus a visible connected-participant count.
    - A composer that sends messages over the WebSocket and clears on send.
    - The signed-in identity and an unconditional `/cdn-cgi/access/logout`
      control in the header.
16. Manage the WebSocket lifecycle in a Pinia store (or a dedicated composable it
    owns): open the socket on channel select, close and reopen it on channel
    switch (so a switch routes to the other channel's Durable Object), append
    incoming messages, and reconnect with backoff on drop — demonstrating that a
    reconnect replays authoritative history from the Durable Object. Use a
    `channels` store for the directory (list, add via `POST`, remove via
    `DELETE`, refreshing the list after each mutation) and a `room`/socket store
    for the live connection. Distinguish an intentional channel-removed close
    (the Durable Object's `destroy()` close code) from a transient drop so the
    client does **not** try to reconnect to a channel that no longer exists, and
    instead surfaces the removal notice and moves the user to a remaining channel.
    Keep `src/client/main.ts` bootstrap-only with `App.vue`, `views/` (one file
    per routed page), `stores/`, and components. Configure static assets to run
    the Worker first only for `/api/*`; all page routes fall through to the SPA
    `ASSETS` fallback (Access gates them at the edge).

### Phase 5 — Tests, deployment, and documentation

17. Add the three Vitest projects listed from a root `vitest.config.ts`:
    - `src/worker/vitest.config.ts` (`environment: node`, `name: worker`): unit
      tests for channel-name validation, the channel repository logic, message
      validation, and the channel-name → `getByName` routing helper.
    - `src/client/vitest.config.ts` (`environment: jsdom`, `name: client`,
      `@vitejs/plugin-vue`): component/behavior tests with `@vue/test-utils` and
      `@pinia/testing` for the channel sidebar, message pane rendering, the
      composer, and the socket store's append/reconnect logic (with a mocked
      WebSocket).
    - `tests/integration/vitest.config.ts` (`name: integration`,
      `@cloudflare/vitest-pool-workers`, `configPath` resolved from
      `import.meta.dirname`): the Worker and the `ChatRoom` Durable Object running
      in real `workerd`, using `@adrianhall/cloudflare-toolkit/testing` helpers
      for Access identities.
18. Integration tests MUST cover the complete primary workflow, the Durable
    Object coordination behavior, and the access boundaries — not just the happy
    path:
    - The WebSocket upgrade requires Access: unauthenticated and wrong-shaped
      (non-upgrade) requests are rejected on `/api/channels/:channel/ws`, and
      `/api/channels` mutations (`POST` and `DELETE`) reject unauthenticated
      requests.
    - Adding a channel makes it appear in `GET /api/channels`; any authenticated
      user (not only its creator) can add and remove channels, and name
      validation rejects malformed or reserved names.
    - Removing a channel deletes its D1 row **and** its Durable Object state: any
      socket connected to it is closed with the removal close code, and rejoining
      a channel recreated with the same name starts with empty history (proving
      `destroy()` cleared the store). Routing to, or upgrading a WebSocket on, a
      removed channel returns `404`.
    - A message posted by one connected client is broadcast to a second client
      connected to the **same** channel, labeled with the sender's verified
      identity (not any client-supplied identity).
    - A client connected to a **different** channel does not receive the first
      channel's messages (routing isolation — distinct Durable Object instances).
    - A client that disconnects and reconnects receives the **recent history
      replay** from the Durable Object (state recovery), including after the
      Durable Object has been allowed to hibernate.
    - Messages are persisted in the Durable Object's SQLite store before
      broadcast, and oversized/invalid message payloads are rejected.
    Configure `@vitest/coverage-istanbul` and a `test:coverage` script; treat
    uncovered authored source as a gap to close.
19. Provide single-command `npm run deploy` (Terraform init/apply, generate
    `wrangler.jsonc` + types with `generate-wrangler -f --terraform infra`, D1
    remote migrate, `vite build`, `wrangler deploy` — which also applies the
    Durable Object migration and creates the `CHAT_ROOM` namespace) and
    `npm run teardown`, composed from small `package.json` scripts chained with
    `run-s`. No R2-style preteardown is needed: the Durable Object namespace and
    all channel state are removed when Terraform destroys the Worker. Add a
    `postteardown` step that removes the generated `wrangler.jsonc` and
    `worker-configuration.d.ts`. A successful teardown leaves no named or
    billable resources — no Worker, Durable Object namespace, D1 database, or
    Access application.
20. Write `README.md` (operator/developer guide: prerequisites, architecture,
    the one-Durable-Object-per-channel model, the D1 channel directory vs.
    Durable-Object-owned message history split, the fully-authenticated Access
    model, the WebSocket-through-Access identity flow, env config, local dev,
    testing, observability, exact deployment and verification steps,
    troubleshooting, and exact teardown steps) and `DEMO.md` (presenter guide
    covering the two-user two-window flow, adding and removing channels,
    channel routing isolation, reconnect recovery, where to find the
    `channel_created` / `channel_removed` / `channel_joined` / `message_posted` /
    `channel_left` logs in Workers Logs, and how to observe the Durable Object in
    the dashboard), plus JSDoc on every authored TypeScript declaration
    describing implemented behavior.
21. Extend `.env.example` from the baseline with only what this demo needs:
    baseline permissions (`Workers Scripts - Edit`, `Access: Apps and Policies -
    Edit`) plus `Account: D1 - Edit`, `DEMO_DOMAIN`, `DEMO_NAME=chat`, and
    `CLOUDFLARE_TEAM_DOMAIN` for Access. Durable Objects need no extra token
    permission beyond `Workers Scripts - Edit`, since the namespace is created by
    the Worker deploy. No `ADMIN_EMAIL` is required because any authenticated user
    is a valid participant. Never commit real secrets or the generated local
    configuration.
22. Verify formatting, linting, type checking, all three Vitest projects, the
    production build, the generated Wrangler configuration, and
    `terraform fmt -check` / `terraform validate` in `infra`. Do not run
    `terraform apply`, deploy, or destroy real resources unless the operator
    explicitly requests it and provides the environment.

### Note — the Durable Object owns authoritative state; the client is a view

The single most important idea in this demo is that the channel's Durable Object,
not any browser, holds the truth. Every message is written to the Durable
Object's SQLite store **before** it is broadcast, and every connect replays that
store, so the visible conversation is always a projection of durable server
state. A tempting shortcut — keeping the message log only in the Durable
Object's in-memory fields, or trusting the client to send its author identity —
would appear to work in a single happy-path session but breaks the exact lessons
the demo exists to teach: reconnect recovery (memory is lost on hibernation or
eviction) and identity integrity (a client could impersonate another user).
Persist first, replay on connect, and pin the Worker-verified identity to the
socket.
