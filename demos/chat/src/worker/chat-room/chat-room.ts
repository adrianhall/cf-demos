import { DurableObject } from "cloudflare:workers";

/**
 * `ChatRoom` is the coordination atom for a single chat channel — one Durable Object instance
 * per channel name, addressed by the Worker via `env.CHAT_ROOM.getByName(channel)`.
 *
 * This is a Phase 1 scaffold placeholder: only the class shape needed to satisfy the
 * `durable_objects` binding and `new_sqlite_classes` migration declared in
 * `wrangler.jsonc.tpl` exists so far, so `wrangler`/`vite` can resolve the `CHAT_ROOM` binding
 * against a real exported class. Phase 3 (see docs/04-ENTERPRISE-CHAT.md, "Durable Object
 * design") implements the SQLite-backed `messages` table created in the constructor, the
 * hibernatable WebSocket upgrade in `fetch()`, message validation and broadcast in
 * `webSocketMessage()`, presence updates in `webSocketClose()`/`webSocketError()`, and the
 * `destroy()` RPC method that purges channel state.
 */
export class ChatRoom extends DurableObject<Env> {}
