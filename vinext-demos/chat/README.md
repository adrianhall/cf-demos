# Chat (Vinext)

A real-time, multi-participant chat workspace deployed to Cloudflare Workers at
`vinext-chat.${CLOUDFLARE_DOMAIN}`. It combines Vinext's React App Router, a Hono API, an
application service, and **two** storage tiers: D1 for the channel directory and one Durable Object
per channel for the live conversation.

This is the Vinext implementation of the sibling
[`cf-terraform-demos/chat`](../../cf-terraform-demos/chat) demo. The Worker tiers — domain,
application, and infrastructure — are the same code; the UI is React rather than Vue, and Vinext
rather than the asset store serves the page. Reading the two side by side shows what a framework
change does and does not touch.

## What this demo teaches

**Two kinds of state need two kinds of storage, and the split is an architectural decision rather
than a technical detail.**

- The **channel directory** — which channels exist, who created them — is a small relational
  catalogue that every participant reads and that needs database-enforced name uniqueness. That is
  D1.
- Each **channel's conversation** is an ordered stream of appends with live fan-out to connected
  readers, and it needs one writer to decide the order everybody observes. That is a Durable Object,
  one per channel name.

`ChatService` (`src/worker/application/chat-service.ts`) is the only place that knows both exist,
and the order in which it touches them on teardown is the demo's most instructive five lines.

It also shows three things that are easy to get wrong:

- **Authorship cannot be asserted by a client.** The verified identity is pinned to a connection
  when it is accepted, and every message reads the author back from that pin — never from the frame.
- **Cloudflare Access as defence in depth**, not as a single gate. The edge Access application
  authenticates; the Worker independently re-validates the JWT _and_ its audience.
- **A WebSocket upgrade is not an ordinary response**, and a framework that rebuilds responses
  cannot carry one. See
  [Why the WebSocket upgrade bypasses the Vinext router](#why-the-websocket-upgrade-bypasses-the-vinext-router).

## Architecture

```text
React UI (Vinext presentation)
        │ same-origin JSON API + one WebSocket
        ▼
Vinext route handlers + Hono Access middleware (delivery)
        ▼
ChatService + domain validation (application/domain)
        ▼
D1ChannelRepository          DurableChatRooms → ChatRoom (infrastructure)
        ▼                              ▼
Cloudflare D1               Durable Object (SQLite, one per channel)
```

- **UI:** Vinext serves the React workspace at `/`. `app/layout.tsx` and `app/page.tsx` stay server
  components; the interactive parts live in `src/ui/` as client components. `useRoom` owns the
  single WebSocket connection.
- **API:** Vinext route handlers adapt `/api/channels/**` and `/api/me` into the Hono application.
  There is no public route.
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
suits neither half. Read replication is disabled in `infra/vinext-chat.tf` because a participant
creates a channel and immediately joins it — that sequence needs read-your-writes consistency.

### Channel isolation is structural

Each channel name addresses a different Durable Object, with its own storage and its own sockets.
There is no cross-channel query to get wrong. Contrast the sibling [`todo`](../todo) demo, where
every user's rows share one table and isolation depends on getting a `WHERE user_id = ?` predicate
right in _every_ statement.

### The teardown ordering rule

Removing a channel is two steps, and the order is deliberate — room first, directory second:

1. `ChatRoom.destroy()` disconnects every participant and erases the conversation.
2. The D1 row is deleted.

Reversed, there would be a window in which the channel is gone from every sidebar while its room is
still live, and connected participants would keep talking in a channel nobody can find. Failing
_between_ the steps in the chosen order is benign: the channel remains listed but empty, and
removing it again finishes the job.

### How authorship is guaranteed

1. Cloudflare Access verifies the identity; `src/worker/routes/identity.ts` reads it from the JWT
   and nowhere else.
2. `DurableChatRooms.join` forwards the upgrade request after `withVerifiedIdentity` strips any
   client-supplied `X-Chat-Identity` header and sets the verified one.
3. `ChatRoom` pins that identity to the socket with `serializeAttachment`, which survives
   hibernation.
4. Every message reads the author back from the attachment. The wire protocol has no author field,
   and the domain rejects any frame that adds one.

An integration test asserts exactly that, including the smuggled-header case.

### WebSocket hibernation

Connections are accepted with `ctx.acceptWebSocket()`, not `socket.accept()`. An idle channel's
sockets stay connected at the edge while the object is evicted from memory, so an empty overnight
channel costs nothing. Everything the room needs after reconstruction therefore lives in storage or
in a socket attachment — never in an instance field.

## Vinext specifics

### The Worker entrypoint is this demo's own module

The sibling `todo` and `link` demos name `vinext/server/app-router-entry` as the `cf` entrypoint
directly. This one names `src/worker-entry.ts`, which re-exports Vinext's handler and adds what
Vinext cannot provide. Two things force that:

1. **The Durable Object class must be a named export on the entry module.** `exports.durableObject`
   in `cloudflare.config.ts` declares a namespace backed by a class called `ChatRoom`, and the
   deploy fails if the uploaded entry module does not export one.
2. **The WebSocket upgrade must not pass through the App Router pipeline**, for the reason below.

### Why the WebSocket upgrade bypasses the Vinext router

> **This is a documented Vinext limitation, not a design preference.** Per the family rules, it is
> flagged here and in [`vinext-demos/AGENTS.md`](../AGENTS.md) rather than worked around silently.

Every other endpoint is an ordinary `app/api/**/route.ts` handler that forwards into the Hono
application. The upgrade cannot be. Vinext 1.0.0's route-handler pipeline reconstructs a handler's
response — `new Response(body, { status, headers })` — to apply cache-control and cookie policy, and
that is fatal to a protocol switch in two independent ways, both at runtime:

- `new Response()` rejects a `101` outright: _"Responses may only be constructed with status codes
  in the range 200 to 599, inclusive."_
- Reconstruction drops the `webSocket` property, which is the only part of the response that
  matters. The pipeline also calls `response.clone()`, which fails with _"Cannot clone a response to
  a WebSocket handshake."_

So `src/worker-entry.ts` sends upgrades straight to the same Hono application. The exception is as
narrow as it can be:

- It is keyed on the **`Upgrade` header**, not on a path. A plain `GET` to the socket route still
  travels the normal Vinext route and gets the API's `426 Upgrade Required` from the same route
  table as every other response.
- It changes no routing. Vinext still owns every path, including `/api/channels/:channel/socket` for
  every non-upgrade request.
- **Authentication is unaffected.** The request reaches the same Hono application, so the same
  `cloudflareAccess` middleware validates the same JWT and the same audience before any room is
  reached. Bypassing the framework is not bypassing the API. An integration test asserts an
  unauthenticated upgrade is refused.

`tests/worker/worker-entry.test.ts` pins this behaviour, so widening the exception fails the build.

A fix in Vinext — passing a `101` response through untouched — would let the upgrade become an
ordinary route handler and would make `src/worker-entry.ts` a two-line class re-export.

### One more portability difference

`withVerifiedIdentity` (`src/worker/infrastructure/room-protocol.ts`) builds its request from
`request.url` rather than with `new Request(request, { headers })` as the Vue sibling does. Under
Vinext the incoming object is the framework's own `Request` subclass, and passing it as the first
argument makes the constructor stringify it as a URL, failing with
`TypeError: Invalid URL: [object Request]`.

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

The policy for `/api/*` uses `redirect: false` specifically because a browser's `WebSocket`
constructor cannot follow a redirect to a login page. There is no `/_next/*` bypass, unlike the
`link` demo: no document here renders for an unauthenticated visitor, so its chunks are only
requested by a browser that already holds a valid Access session.

**This demo has no administrator role.** Any authenticated participant may create or remove any
channel. That keeps the removal path about two-store teardown ordering rather than about
authorization; a real product would gate it, most simply by checking `createdBy`. See the sibling
[`link`](../link) demo for an administrator-gated surface.

## Local database migrations

Migrations are applied by the shared [`scripts/d1-migrate.ts`](../../scripts/d1-migrate.ts) helper
at the repository root:

```bash
pnpm migrate:local    # local simulation, ID from infra/local-outputs.json
pnpm migrate:remote   # real database, ID from infra/outputs.json
```

`pnpm start` runs `migrate:local` before `cf dev`, so a fresh clone gets a migrated database
automatically. Delete `.cloudflare/state` to reset the local database.

Only the **D1** directory is migrated. Each Durable Object creates its own SQLite table on demand,
because every channel has a private database that does not exist until the channel is first used.

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
derives the Worker name, database name, and hostname from its fixed demo name: `vinext-chat`,
`vinext-chat-db`, and `vinext-chat.${CLOUDFLARE_DOMAIN}`.

## Install

From the repository root:

```bash
pnpm install
```

## Local development

```bash
cd vinext-demos/chat
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
rather than fail it.

The Workers-runtime suite points at `tests/integration/worker-entry.ts`, which pairs the real
`ChatRoom` class with the Hono application. A Durable Object namespace binds to a named class export
on whichever module the runtime is pointed at, so the entrypoint cannot be `src/worker/index.ts`.

A production build emits an informational `INEFFECTIVE_DYNAMIC_IMPORT` warning from Vinext. It is
not a failure and no configuration is added to suppress it.

## Deploy

```bash
pnpm deploy
```

The command:

1. initializes and applies Terraform to create the Worker registration, D1 database, custom
   hostname, and Cloudflare Access application/policy;
2. writes live Terraform outputs to the ignored `infra/outputs.json`;
3. applies D1 migrations to the real database using the ID from those outputs;
4. builds the React assets and Worker with those resource IDs; and
5. uploads the prebuilt Worker.

The `CHAT_ROOM` Durable Object namespace is **not** created by Terraform. A Durable Object namespace
is defined by the class its Worker exports, so it is provisioned by the same `cf deploy` that
uploads the code (`exports.durableObject` in `cloudflare.config.ts`). Splitting that ownership would
give one resource two owners.

Afterward, visit `https://vinext-chat.${CLOUDFLARE_DOMAIN}` in two browsers signed in as different
identities and run through the same steps as local development. In the dashboard under **Workers &
Pages** → `vinext-chat` → **Logs**, confirm a `message_posted` event was recorded — note it carries
the message identifier and participant count but deliberately **not** the author or the body, since
one is personal data and the other is user content.

## Teardown

```bash
pnpm teardown
```

This first deletes the deployed Worker with `cf workers delete`, which removes deploy-managed D1
bindings **and** the `CHAT_ROOM` Durable Object namespace along with every channel's stored
conversation. It then runs `terraform destroy` to remove the Worker registration, D1 database,
custom domain, and Access configuration. The explicit `depends_on` in `infra/vinext-chat.tf` forces
that ordering, because Cloudflare refuses to delete a database still bound to a live Worker.

## Troubleshooting

| Symptom                                                                 | Cause and resolution                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `terraform apply` fails with error `100124` attaching the custom domain | Expected on a truly fresh Worker; re-run `pnpm deploy` — the inert bootstrap version/deployment satisfies the required ordering.                                                           |
| Access sign-in is denied                                                | Confirm the Zero Trust organization has an enabled identity provider; this demo accepts any.                                                                                               |
| The socket never connects, with no error                                | Confirm `src/worker-entry.ts` still exports `ChatRoom` _and_ still routes `Upgrade: websocket` to the API. Routing an upgrade through a Vinext route handler fails at runtime — see above. |
| A `RangeError` about status codes appears in the log                    | Something is returning the `101` through Vinext's route-handler pipeline, which rebuilds responses. The upgrade must be dispatched from `src/worker-entry.ts`.                             |
| `TypeError: Invalid URL: [object Request]`                              | A `new Request(request, …)` was reintroduced somewhere. Under Vinext the request is a framework subclass; build from `request.url` instead, as `withVerifiedIdentity` does.                |
| A channel never receives messages sent in another window                | Confirm both windows selected the _same_ channel. A different name always routes to a different Durable Object, by design.                                                                 |
| A recreated channel still shows old messages                            | Confirm the removal returned `204`. `ChatRoom.destroy()` erases storage before the D1 row is deleted.                                                                                      |
| `pnpm migrate:local` reports a timeout twice                            | A local simulation is wedged. `rm -rf .cloudflare/state` and retry; if it persists, check for an orphaned `workerd` process.                                                               |
