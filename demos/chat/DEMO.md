# Demo: Enterprise Chat

> **Status:** Phases 1 and 2 of `docs/04-ENTERPRISE-CHAT.md` are complete. The hostname and
> `/api/*` are Access-protected and the `D1`/`CHAT_ROOM` bindings exist, but there is nothing to
> present yet — there is no channel API, no `ChatRoom` behavior, and no chat UI. This file will
> be filled in with the full two-user presenter flow once Phases 3-5 land.

## Access Demonstration

After deployment, open `https://chat.cfapps.uk`. Cloudflare Access requires a sign-in through
any enabled identity provider before serving the SPA shell — there is no public bypass
application, because every participant in this demo must have a verified identity. API
requests (and, once Phase 3 lands, the WebSocket upgrade requests they precede) are
independently validated by the Worker, which makes the verified Access identity available to
later channel and message routes without ever accepting a client-supplied identity.

For local development, `npm start` presents a local Access login page with the selectable
identities `alice@example.com` and `bob@example.com` — the two identities the eventual two-user
demo flow needs. The always-visible **Sign out** link uses `/cdn-cgi/access/logout`, which the
plugin emulates locally and Cloudflare Access serves in production.

## What Will Be Demonstrated (Once Complete)

- **Durable Objects** as the coordination atom for a chat channel: one `ChatRoom` instance per
  channel name, routed to with `getByName(channel)`, holding the channel's authoritative
  message history and broadcasting to every connected participant.
- **Hibernatable WebSockets**: an idle channel consumes no duration while its connections and
  state are preserved, and a reconnecting client recovers recent history from the Durable
  Object's own SQLite storage rather than an empty room.
- **Cloudflare Access** providing every request's verified user identity — including on the
  WebSocket upgrade — with no separate login system and no way for a client to spoof another
  participant.
- **D1** as the small, shared channel directory, reused from Demo 2, kept deliberately separate
  from the Durable-Object-owned message history.
- **Workers Logs** showing structured `channel_created`, `channel_removed`, `channel_joined`,
  `message_posted`, and `channel_left` events for real, authorized activity.

## Planned Demonstration Flow

1. Open two browser windows and sign in as two different identities (User A and User B), each
   joining the same channel.
2. Post a message as User A and watch it appear immediately in both windows, labeled with User
   A's identity.
3. Add a new channel as User A and confirm it appears in User B's channel list; switch to it and
   confirm messages from the first channel do not appear — a different channel name routes to a
   different Durable Object.
4. Close and reopen User B's window, rejoin the first channel, and confirm the recent history
   replays from the channel's Durable Object storage.
5. Remove a channel and confirm it disappears from both channel lists, any window viewing it is
   dropped with a clear notice, and rejoining a channel by that name later starts empty.
6. Open **Workers & Pages → chat → Logs** in the Cloudflare dashboard and locate the
   `channel_created`, `channel_removed`, `channel_joined`, `message_posted`, and `channel_left`
   events, correlated by channel and request.

See `docs/04-ENTERPRISE-CHAT.md` for the full implementation plan.
