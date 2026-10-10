# Chat — What This Demo Teaches

## What This Demonstrates

- **Durable Objects as a per-channel coordination atom.** `ChatRoom` is instantiated once per channel name via `env.CHAT_ROOM.getByName(channel)`. A different name always resolves to a different Durable Object instance, so channels are isolated from one another by construction — there is no cross-channel query to get wrong, and no shared in-memory state that could leak between rooms.
- **Hibernatable WebSockets for cost-free idle connections.** The Durable Object accepts sockets with `ctx.acceptWebSocket(server)` (the Hibernation API), not `server.accept()`. An idle channel's sockets stay connected to the Cloudflare network while the object itself is evicted from memory and stops accruing duration charges; when a message arrives, the runtime re-initializes the object and re-runs its constructor automatically.
- **Persisting authoritative state in the Durable Object's own SQLite storage, not client-side memory.** Every message is written to the object's embedded SQLite `messages` table *before* it is broadcast to any socket. Because the store — not any browser tab or any in-memory field — is authoritative, a client that disconnects and reconnects (or a Durable Object that hibernates or is evicted) always recovers the same real history, not a blank room seeded from whatever the client happened to remember.
- **A deliberate split between the D1 channel directory and Durable-Object-owned room state.** D1 holds a small, relational catalog of channel *names* — which channels exist, who created them, when — because that's exactly the shape of data D1 is good at. The Durable Object owns each channel's live conversation and connected sockets, because that's a single-writer coordination problem, not a query problem. Neither store tries to do the other's job.
- **Why Workers KV is deliberately absent.** KV's eventually-consistent, single-key model fits neither piece of this demo's state: it cannot coordinate the ordered broadcast a chat room needs, and D1 already covers the small channel catalog that would otherwise be tempting to put there. Adding KV would introduce a third state store without teaching a new lesson.

## How It Works

### WebSocket-through-Access identity flow

The browser opens its WebSocket to a same-origin `/api/channels/:channel/ws` URL, so the upgrade request carries the same Access session cookie as any other request and is verified by `cloudflareAccess()` in `src/worker/middleware/access.ts` exactly like an ordinary route. The Worker never lets a client assert its own identity: `src/worker/routes/rooms.ts` deletes any inbound `X-Chat-Identity`/`X-Chat-Channel` headers, then sets its own values from the verified Access identity and the validated channel name before forwarding the request to `env.CHAT_ROOM.getByName(channel).fetch(...)`. Because the Durable Object is only ever reached through the Worker (it has no public route of its own), it can trust those headers unconditionally — `src/worker/chat-room/chat-room.ts` reads them once in `fetch()` and pins the email to the socket with `server.serializeAttachment({ email, channel })`, which survives hibernation. `webSocketMessage()` always reads the author back out of `deserializeAttachment()`, never from the incoming frame, so a connected client can never post as someone else.

### Persist-then-broadcast message flow

On a new connection, the Durable Object replays a bounded window of recent history from SQLite as the first frame, then broadcasts a presence update. On every incoming message, `webSocketMessage()` validates the body, inserts it into the `messages` table with a `RETURNING` clause to get back the assigned id and timestamp, trims the table to the most recent rows, and only then calls `broadcast()` over every socket from `ctx.getWebSockets()`. Persist-first, broadcast-second means a message is never visible to any client before it is durable — if the object were evicted the instant after broadcasting but before persisting, a client could see a message that the room's history would never replay.

### The `destroy()` RPC lifecycle

Channel removal (`DELETE /api/channels/:channel`) is a two-step teardown, Durable-Object state first: the route calls `env.CHAT_ROOM.getByName(name).destroy()`, which sends a `channel_removed` frame and closes every connected socket with a dedicated close code (`CHANNEL_REMOVED_CLOSE_CODE`, shared with the browser via `src/chat-protocol.ts` so the client can tell an intentional removal apart from a transient drop and skip its normal reconnect-with-backoff), then calls `ctx.storage.deleteAll()` and immediately reinitializes the schema so the *same* Durable Object instance is ready for a channel later recreated with the same name. Only after that completes does the route delete the D1 directory row. Because Durable Objects are addressed purely by name, a channel re-created with the same name always starts from an empty store — there is no orphaned state to accidentally resurrect.

### Why the whole hostname requires authentication

Unlike `demos/media-drop`, which mixes a public route with an authenticated one behind two Access applications, chat has no anonymous surface at all: the entire `chat.cfapps.uk` hostname sits behind a single Access application backed by an `allow` policy that requires a real identity provider sign-in. The whole point of the demo is showing *who* said what and keeping two participants' identities apart, so there is nothing here for an anonymous bypass to usefully serve — even the SPA shell is gated at the edge before the request reaches the Worker or the `ASSETS` binding.

## Further Reading

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Durable Object Namespace API (`getByName`)](https://developers.cloudflare.com/durable-objects/api/namespace/)
- [Use WebSockets with Durable Objects (Hibernation API)](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Access Durable Objects storage (SQL API)](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [D1 Worker Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cloudflare Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Workers observability](https://developers.cloudflare.com/workers/observability/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
