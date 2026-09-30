# Chat

A real-time, multi-participant chat workspace deployed to Cloudflare Workers at
[`chat.cfapps.uk`](https://chat.cfapps.uk) (when the repository-root `.env` has
`CLOUDFLARE_DOMAIN="cfapps.uk"`). It combines a Vue UI, a Hono API, an application service, and
**two** storage tiers: D1 for the channel directory and one Durable Object per channel for the live
conversation.

## What this demo teaches

**Two kinds of state need two kinds of storage, and the split is an architectural decision rather
than a technical detail.**

- The **channel directory** — which channels exist, who created them — is a small relational
  catalogue that every participant reads and that needs database-enforced name uniqueness. That is
  D1.
- Each **channel's conversation** is an ordered stream of appends with live fan-out to connected
  readers, and it needs one writer to decide the order everybody observes. That is a Durable Object,
  one per channel name.

Neither store tries to do the other's job, and the seam between them is visible: `ChatService`
(`src/worker/application/chat-service.ts`) is the only place that knows both exist, and the order in
which it touches them on teardown is the demo's most instructive five lines.

It also shows two things that are easy to get wrong:

- **Authorship cannot be asserted by a client.** The verified identity is pinned to a connection
  when it is accepted, and every message reads the author back from that pin — never from the frame.
- **Cloudflare Access as defence in depth**, not as a single gate. The edge Access application
  authenticates; the Worker independently re-validates the JWT _and_ its audience.

## Architecture

```text
Vue UI (presentation)
        │ same-origin JSON API + one WebSocket
        ▼
Hono routes + Access middleware (delivery)
        ▼
ChatService + domain validation (application/domain)
        ▼
D1ChannelRepository          DurableChatRooms → ChatRoom (infrastructure)
        ▼                              ▼
Cloudflare D1               Durable Object (SQLite, one per channel)
```

- **UI:** Vue 3, Pinia, and Vuetify render the workspace at `/`.
- **API:** Hono exposes `/api/channels`, `/api/me`, and the WebSocket upgrade at
  `/api/channels/:channel/socket`. There is no public route.
- **Application/domain:** `ChatService` owns the use cases and depends only on the
  `ChannelRepository` and `ChatRoomPort` **ports**. Validation lives in the domain, so a message
  arriving over a WebSocket is held to exactly the same rules an HTTP transport would apply.
- **Infrastructure:** `D1ChannelRepository` and `ChatRoom` implement those ports.

Dependencies point one way only. `src/worker/index.ts` is the single composition root that knows
both concrete stores; route handlers never construct a repository or reach for a Durable Object
namespace.

### Why a Durable Object for messages, and D1 for the directory

| Need                                      | D1                                | Durable Object                       |
| ----------------------------------------- | --------------------------------- | ------------------------------------ |
| Unique channel names, enforced by storage | ✅ `PRIMARY KEY`                  | ✖ no cross-instance constraint       |
| One shared list every participant reads   | ✅                                | ✖ would need a coordinating instance |
| A single writer deciding message order    | ✖                                 | ✅ one instance per channel          |
| Delivery to _connected_ readers           | ✖ no notion of a connected reader | ✅ holds the WebSockets              |

Workers KV is deliberately absent: it is eventually consistent and queryable only by key, so it
suits neither half. Adding it would introduce a third store without teaching a third lesson.

Read replication is disabled in `infra/chat.tf` because a participant creates a channel and
immediately joins it — that sequence needs read-your-writes consistency.

### Channel isolation is structural

Each channel name addresses a different Durable Object, with its own storage and its own sockets.
There is no cross-channel query to get wrong. Contrast the sibling [`todo`](../todo) demo, where
every user's rows share one table and isolation depends on getting a `WHERE user_id = ?` predicate
right in _every_ statement. Both are legitimate; they are different tools for different shapes of
problem.

### The teardown ordering rule

Removing a channel is two steps, and the order is deliberate — room first, directory second:

1. `ChatRoom.destroy()` disconnects every participant and erases the conversation.
2. The D1 row is deleted.

Reversed, there would be a window in which the channel is gone from every sidebar while its room is
still live, and connected participants would keep talking in a channel nobody can find. Failing
_between_ the steps in the chosen order is benign: the channel remains listed but empty, and
removing it again finishes the job. The other order's failure mode — an orphaned room holding
messages with no directory entry — is unreachable and unremovable through the API.

### How authorship is guaranteed

1. Cloudflare Access verifies the identity; `src/worker/routes/identity.ts` reads it from the JWT
   and nowhere else.
2. `DurableChatRooms.join` forwards the upgrade request after `withVerifiedIdentity` strips any
   client-supplied `X-Chat-Identity` header and sets the verified one.
3. `ChatRoom` pins that identity to the socket with `serializeAttachment`, which survives
   hibernation.
4. Every message reads the author back from the attachment. The wire protocol has no author field,
   and the domain rejects any frame that adds one.

A participant therefore cannot post as somebody else even controlling every byte they send. An
integration test asserts exactly that, including the smuggled-header case.

### Why the upgrade uses `fetch` and everything else uses RPC

`ChatRoom.destroy()` is a typed RPC call. Joining cannot be: the response carries a live
`WebSocket`, which is not serializable across an RPC boundary (`DataCloneError`), and the
Hibernation API completes the protocol switch against the incoming request itself. So the upgrade
travels as a request and the identity travels as a header — with
`src/worker/infrastructure/ room-protocol.ts` responsible for making sure that header can only hold
a verified value.

### WebSocket hibernation

Connections are accepted with `ctx.acceptWebSocket()`, not `socket.accept()`. An idle channel's
sockets stay connected at the edge while the object is evicted from memory, so an empty overnight
channel costs nothing. Everything the room needs after reconstruction therefore lives in storage or
in a socket attachment — never in an instance field.

## Access and authorization

Two independent controls protect the API, and **both** are required:

1. **Edge:** one Cloudflare Access application covers the whole hostname with an `allow` policy
   admitting any identity from the team's providers. `everyone` inside an `allow` decision still
   requires a completed login — it is not a `bypass`.
2. **In-Worker:** `cloudflareAccess` re-validates the JWT and checks its `aud` claim against the
   Access application's Audience tag, which Terraform publishes as the `access_aud` output.

The audience check is the part that matters most: every Access application in a team shares one
JWKS, so signature validation alone would accept a token minted for an unrelated application in the
same team. An integration test asserts such a token is rejected.

The WebSocket upgrade is authenticated by the same middleware as every other route — it is a
same-origin request carrying the same Access cookie, so there is no separate socket authentication
path that could be weaker. The policy for `/api/*` uses `redirect: false` specifically because a
browser's `WebSocket` constructor cannot follow a redirect to a login page.

**This demo has no administrator role.** Any authenticated participant may create or remove any
channel. That keeps the removal path about two-store teardown ordering rather than about
authorization; a real product would gate it, most simply by checking `createdBy`. See the sibling
[`link`](../link) demo for an administrator-gated surface.

## Local database migrations

Migrations are applied by the shared [`scripts/d1-migrate.ts`](../../scripts/d1-migrate.ts) helper
at the repository root, because the logic is identical for any D1-backed demo:

```bash
pnpm migrate:local    # local simulation, ID from infra/local-outputs.json
pnpm migrate:remote   # real database, ID from infra/outputs.json
```

`pnpm start` runs `migrate:local` before `cf dev`, so a fresh clone gets a migrated database
automatically.

Notes on `cf d1 migrations apply`, all verified against `cf@1.0.0-beta.5` rather than assumed:

- **It requires a database ID, not a name.** The ID is not known until Terraform creates the
  database, which is why a script reads it from the Terraform outputs.
- **`--persist-to` is specified explicitly**, pinning local state to this demo's `.cloudflare/state`
  rather than an OS-specific user directory.
- **The local binding is pinned by ID too**, so `cf dev` reads the schema the migration created.
- **Local runs are bounded at 30 seconds and retried once.** Local migrations occasionally hang
  during `workerd` startup instead of failing, which would otherwise stall a pipeline indefinitely.
  On timeout the whole process group is killed — not just `cf` — so no orphaned `workerd` holds the
  state directory and poisons the retry. Remote runs are deliberately unbounded: their duration
  depends on network latency and real work.

Only the **D1** directory is migrated. Each Durable Object creates its own SQLite table on demand,
because every channel has a private database that does not exist until the channel is first used —
there is nothing to migrate ahead of time and nowhere central to migrate it.

Delete `.cloudflare/state` to reset the local database.

Integration tests do **not** use the CLI. The Workers pool creates its own isolated D1 database per
run, so `tests/integration/vitest.config.ts` reads the migrations with `readD1Migrations` and the
suite applies them with `applyD1Migrations`. A broken migration therefore fails `pnpm test` rather
than only failing a deploy.

## Prerequisites

- Node.js 24 or later
- pnpm 12 or later
- Terraform 1.10 or later
- A Cloudflare account, a Cloudflare-hosted zone, and a configured Cloudflare Zero Trust team with
  at least one enabled identity provider
- The repository-root [`.env`](../../.env) created with `pnpm create-env`

The API token in the root `.env` needs:

- **Account:** Workers Scripts — Edit; D1 — Edit; Access — Edit; Access: Identity Providers — Read
- **Zone:** DNS — Edit

The demo uses the central environment file — there is no `.env` inside this directory. Terraform
derives the Worker name, database name, and hostname from its fixed demo name: `chat`, `chat-db`,
and `chat.${CLOUDFLARE_DOMAIN}`.

## Install

From the repository root:

```bash
pnpm install
```

## Local development

```bash
cd cf-terraform-demos/chat
pnpm start
```

This applies the D1 migration locally and starts the Cloudflare/Vite development environment. No
`.dev.vars` file is required or tracked: the absence of `ENVIRONMENT` deliberately selects the
toolkit's development logging defaults, while production binds `ENVIRONMENT=production`.

The local Cloudflare Access emulator offers two identities, **Alice** (`alice@example.com`) and
**Bob** (`bob@example.com`). To see what this demo is about, you need both at once:

1. Open the app in a normal window and sign in as Alice.
2. Open it in a private window and sign in as Bob.
3. Select the same channel in both and send a message from each. Every message appears instantly in
   both windows, attributed to whoever actually sent it, and the participant count reads 2.
4. Add a channel in one window; it appears in the other's sidebar after that window reloads the
   directory.
5. Remove the channel Bob is viewing from Alice's window. Bob is told the channel was removed and
   moved to a remaining one — without reconnecting to a channel that no longer exists.

## Quality checks

```bash
pnpm check          # TypeScript, Oxfmt, Oxlint + tsgolint, Terraform validation/format
pnpm fix            # Apply Oxfmt, safe Oxlint fixes, and Terraform formatting
pnpm test           # All unit, UI, and Workers-runtime integration tests
pnpm test:coverage  # All tests with coverage
pnpm build          # Local-mode Vite/Worker build
```

`cf workers types --mode development` generates `.cloudflare/types/index.d.ts` directly from
`cloudflare.config.ts`. The `check:types` script runs it before TypeScript, so no handwritten or
committed binding-types file is needed.

The integration project sets a finite `testTimeout`, and every WebSocket wait in
`tests/integration/fixtures.ts` is bounded by a shorter one — a socket has no equivalent of a failed
HTTP response to reject on, so an unbounded wait for a frame that never arrives would hang the suite
rather than fail it. The shorter inner bound means a delivery failure reports _which_ frame never
came.

## Deploy

```bash
pnpm deploy
```

The command:

1. initializes and applies Terraform to create the Worker registration, D1 database, custom
   hostname, and Cloudflare Access application/policy;
2. writes live Terraform outputs to the ignored `infra/outputs.json`;
3. applies D1 migrations to the real database using the ID from those outputs;
4. builds the Vue assets and Worker with those resource IDs; and
5. uploads the prebuilt Worker.

The `CHAT_ROOM` Durable Object namespace is **not** created by Terraform. A Durable Object namespace
is defined by the class its Worker exports, so it is provisioned by the same `cf deploy` that
uploads the code (`exports.durableObject` in `cloudflare.config.ts`). Splitting that ownership would
give one resource two owners.

Afterward, visit `https://chat.${CLOUDFLARE_DOMAIN}` in two browsers signed in as different
identities and run through the same steps as local development. In the dashboard under **Workers &
Pages** → `chat` → **Logs**, confirm a `message_posted` event was recorded — note it carries the
message identifier and participant count but deliberately **not** the author or the body, since one
is personal data and the other is user content.

## Teardown

```bash
pnpm teardown
```

This first deletes the deployed Worker with `cf workers delete`, which removes deploy-managed D1
bindings **and** the `CHAT_ROOM` Durable Object namespace along with every channel's stored
conversation. It then runs `terraform destroy` to remove the Worker registration, D1 database,
custom domain, and Access configuration. The explicit `depends_on` in `infra/chat.tf` forces that
ordering, because Cloudflare refuses to delete a database still bound to a live Worker.

## Troubleshooting

| Symptom                                                                 | Cause and resolution                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `terraform apply` fails with error `100124` attaching the custom domain | Expected on a truly fresh Worker; re-run `pnpm deploy` — the inert bootstrap version/deployment satisfies the required ordering.                                                           |
| Access sign-in is denied                                                | Confirm the Zero Trust organization has an enabled identity provider; this demo accepts any.                                                                                               |
| The socket never connects, with no error                                | Confirm `src/worker/index.ts` still re-exports `ChatRoom`. The `exports.durableObject` entry in `cloudflare.config.ts` requires a named export of exactly that name from the entry module. |
| A channel never receives messages sent in another window                | Confirm both windows selected the _same_ channel. A different name always routes to a different Durable Object, by design.                                                                 |
| A recreated channel still shows old messages                            | Confirm the removal returned `204`. `ChatRoom.destroy()` erases storage before the D1 row is deleted.                                                                                      |
| `pnpm migrate:local` reports a timeout twice                            | A local simulation is wedged. `rm -rf .cloudflare/state` and retry; if it persists, check for an orphaned `workerd` process.                                                               |
